"""Postgres LISTEN/NOTIFY loop. Picks up `scan_queued` payloads and dispatches scans.

Concurrency is bounded by `WORKER_CONCURRENCY`. When at capacity, new notifications are
queued and processed FIFO.
"""

from __future__ import annotations

import asyncio
import logging

import psycopg

from .config import WorkerConfig
from .runner import run_scan
from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)


class ScanQueueListener:
    def __init__(self, cfg: WorkerConfig, sb: WorkerSupabase) -> None:
        self.cfg = cfg
        self.sb = sb
        self._semaphore = asyncio.Semaphore(cfg.worker_concurrency)
        self._stopping = asyncio.Event()

    async def run(self) -> None:
        # On startup, sweep any scans that were left in 'queued' before the worker
        # was running (e.g. crashed previously).
        await self._sweep_pending()

        async with await psycopg.AsyncConnection.connect(
            self.cfg.supabase_db_url, autocommit=True
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute("LISTEN scan_queued")
                logger.info("listening for scan_queued notifications")

                while not self._stopping.is_set():
                    try:
                        async for notify in conn.notifies():
                            scan_id = notify.payload
                            asyncio.create_task(self._dispatch(scan_id))
                            if self._stopping.is_set():
                                break
                    except (psycopg.OperationalError, ConnectionError) as e:
                        logger.warning("LISTEN connection dropped (%s); reconnecting", e)
                        await asyncio.sleep(1)
                        # Outer `async with` will reconnect; we rely on the LISTEN re-issued
                        # by the surrounding loop.
                        return

    async def stop(self) -> None:
        self._stopping.set()

    async def _dispatch(self, scan_id: str) -> None:
        async with self._semaphore:
            try:
                await run_scan(scan_id, self.cfg, self.sb)
            except Exception:  # noqa: BLE001
                logger.exception("dispatch failed for scan %s", scan_id)

    async def _sweep_pending(self) -> None:
        """At startup, look for queued scans that may have been notified while we were down."""
        try:
            res = (
                self.sb.client.table("scans")
                .select("id")
                .eq("status", "queued")
                .order("created_at", desc=False)
                .limit(50)
                .execute()
            )
            for row in res.data or []:
                logger.info("re-dispatching pre-existing queued scan %s", row["id"])
                asyncio.create_task(self._dispatch(row["id"]))
        except Exception as e:  # noqa: BLE001
            logger.warning("sweep failed: %s", e)

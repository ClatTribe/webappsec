"""Postgres LISTEN/NOTIFY loop.

Picks up:
  - `scan_queued` payloads -> dispatch a new scan run
  - `scan_cancel` payloads -> SIGTERM the matching subprocess (if we own it)
  - `target_discovery_requested` payloads -> enumerate subdomains via crt.sh

Also runs a periodic stuck-scan sweep so a worker that dies mid-run (or hangs
on a stalled LLM call) doesn't leave the row in 'running' indefinitely.

Concurrency is bounded by `WORKER_CONCURRENCY`. When at capacity, new
notifications are queued and processed FIFO. Discovery jobs run on a
separate (uncapped) lane — they're cheap HTTP calls, not LLM scans.
"""

from __future__ import annotations

import asyncio
import logging

import psycopg

from .config import WorkerConfig
from .discovery import discover_subdomains_for_target
from .notifier import forward_agent_message_to_slack
from .runner import cancel_running_scan, run_scan
from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)


# How often to sweep for stuck scans, and how silent a scan must be before we
# call it stuck. Heartbeat ticks every 60s; a 10-minute silence is a generous
# multiple that absorbs LLM-call backoff without paging.
STALE_SWEEP_INTERVAL_SEC = 5 * 60
STALE_SCAN_TOLERANCE_SEC = 10 * 60

# How often to call worker_enqueue_scheduled_scans (migration 050). The
# wall-clock check inside the RPC bucketizes by day/week/month so running
# every minute is wasteful — once per minute is plenty for daily cadence,
# once every 5 minutes is plenty for weekly/monthly. We pick 60s to keep
# UX snappy: a freshly-registered daily target gets its first scheduled
# scan within ~60s of becoming due (whereas, e.g., 5min would mean the
# first scan can slip into the next minute by 5 minutes).
SCHEDULED_SCAN_INTERVAL_SEC = 60


class ScanQueueListener:
    def __init__(self, cfg: WorkerConfig, sb: WorkerSupabase) -> None:
        self.cfg = cfg
        self.sb = sb
        self._semaphore = asyncio.Semaphore(cfg.worker_concurrency)
        self._stopping = asyncio.Event()

    async def run(self) -> None:
        # On startup, sweep any scans that were left in 'queued' before the worker
        # was running (e.g. crashed previously) and any 'running' scans that no
        # longer have a live worker behind them.
        await self._sweep_pending()
        sweeper = asyncio.create_task(self._stale_sweep_loop())
        scheduler = asyncio.create_task(self._scheduled_scan_loop())

        try:
            async with await psycopg.AsyncConnection.connect(
                self.cfg.supabase_db_url, autocommit=True
            ) as conn:
                async with conn.cursor() as cur:
                    await cur.execute("LISTEN scan_queued")
                    await cur.execute("LISTEN scan_cancel")
                    await cur.execute("LISTEN target_discovery_requested")
                    await cur.execute("LISTEN agent_message_for_slack")
                    logger.info(
                        "listening for scan_queued + scan_cancel + "
                        "target_discovery_requested + agent_message_for_slack "
                        "notifications"
                    )

                    while not self._stopping.is_set():
                        try:
                            async for notify in conn.notifies():
                                self._handle_notify(notify.channel, notify.payload)
                                if self._stopping.is_set():
                                    break
                        except (psycopg.OperationalError, ConnectionError) as e:
                            logger.warning("LISTEN connection dropped (%s); reconnecting", e)
                            await asyncio.sleep(1)
                            return
        finally:
            sweeper.cancel()
            scheduler.cancel()

    async def stop(self) -> None:
        self._stopping.set()

    def _handle_notify(self, channel: str, payload: str) -> None:
        if channel == "scan_queued":
            asyncio.create_task(self._dispatch(payload))
        elif channel == "scan_cancel":
            # Run synchronously — sending SIGTERM is local + cheap and we want
            # the next signal-arriving notification to see updated state.
            cancelled = cancel_running_scan(payload)
            if cancelled:
                logger.info("scan %s cancel requested; SIGTERM sent", payload)
            else:
                # Either we don't own this scan (another worker does) or it's
                # already exited. Either way, no-op locally.
                logger.debug(
                    "scan %s cancel notification ignored (not owned by this worker)",
                    payload,
                )
        elif channel == "agent_message_for_slack":
            # Forward an agent_messages row to the org's Slack webhook.
            # Cheap I/O bound work; bypass the scan semaphore. A delivery
            # failure is logged but never fails the worker.
            asyncio.create_task(self._dispatch_slack_bridge(payload))
        elif channel == "target_discovery_requested":
            # Discovery jobs are cheap (one HTTP call, parse, write). They
            # share the worker process but bypass the scan-concurrency
            # semaphore — no point queuing a 10-second crt.sh call behind
            # a 30-minute LLM scan.
            asyncio.create_task(self._dispatch_discovery(payload))
        else:
            logger.debug("ignoring unknown notify channel %s", channel)

    async def _dispatch(self, scan_id: str) -> None:
        async with self._semaphore:
            try:
                await run_scan(scan_id, self.cfg, self.sb)
            except Exception:  # noqa: BLE001
                logger.exception("dispatch failed for scan %s", scan_id)

    async def _dispatch_discovery(self, target_id: str) -> None:
        try:
            await discover_subdomains_for_target(self.sb, target_id)
        except Exception:  # noqa: BLE001
            # Discovery is best-effort; a failure here is logged but
            # doesn't surface to the user (the target is still scannable).
            logger.exception("discovery failed for target %s", target_id)

    async def _dispatch_slack_bridge(self, message_id: str) -> None:
        try:
            await forward_agent_message_to_slack(self.sb, message_id)
        except Exception:  # noqa: BLE001
            # Slack forwarding is best-effort — agent messages live
            # canonically in agent_messages; a Slack 5xx is not an
            # incident. A failure here is logged and the worker moves
            # on, same pattern as scan-completion notifier.
            logger.exception("slack bridge failed for message %s", message_id)

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

    async def _scheduled_scan_loop(self) -> None:
        """Periodically enqueue scheduled scans (Phase F v1).

        Calls worker_enqueue_scheduled_scans() every
        SCHEDULED_SCAN_INTERVAL_SEC. The RPC handles all the cadence
        math + idempotence (won't double-enqueue if a scan is already
        in flight). The worker's existing scan_queued listener picks up
        the freshly-inserted rows via pg_notify.

        Single-worker race: if multiple workers are running, they'll
        all call this RPC. Per-target dedup inside the SQL function
        protects against double-enqueue (the "no in-flight scan"
        guard runs inside the same transaction as the insert). One
        worker may "win" a particular target in any given tick.
        """
        # Stagger the first tick like the stale sweeper does — avoids
        # a thundering herd of fleet workers all hitting the DB at boot.
        try:
            await asyncio.sleep(min(30, SCHEDULED_SCAN_INTERVAL_SEC))
        except asyncio.CancelledError:
            return
        while not self._stopping.is_set():
            try:
                n = self.sb.enqueue_scheduled_scans()
                if n > 0:
                    logger.info("enqueued %d scheduled scan(s)", n)
            except Exception:  # noqa: BLE001
                logger.exception("scheduled-scan sweep failed")
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=SCHEDULED_SCAN_INTERVAL_SEC
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                return

    async def _stale_sweep_loop(self) -> None:
        """Periodically reap scans whose worker has gone silent.

        A scan that's still 'running' but whose last_heartbeat_at is older
        than STALE_SCAN_TOLERANCE_SEC is almost certainly orphaned — its
        worker either crashed, was OOM-killed, or got disconnected. We flip
        those to 'failed' so the slot frees up.
        """
        # Stagger the first sweep so a fleet of workers all booting at the
        # same time don't pile on the DB at once.
        try:
            await asyncio.sleep(STALE_SWEEP_INTERVAL_SEC)
        except asyncio.CancelledError:
            return
        while not self._stopping.is_set():
            try:
                stale = self.sb.mark_stale_scans(STALE_SCAN_TOLERANCE_SEC)
                if stale:
                    logger.warning(
                        "marked %d stuck scan(s) as failed: %s", len(stale), stale
                    )
            except Exception:  # noqa: BLE001
                logger.exception("stale-scan sweep failed")
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=STALE_SWEEP_INTERVAL_SEC
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                return

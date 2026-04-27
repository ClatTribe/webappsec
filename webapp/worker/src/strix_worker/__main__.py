"""Entry point for the worker process: `strix-worker`."""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from .config import WorkerConfig
from .listener import ScanQueueListener
from .supabase_client import WorkerSupabase


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


async def _main_async() -> None:
    cfg = WorkerConfig.from_env()
    _configure_logging(cfg.log_level)
    log = logging.getLogger("strix_worker")
    log.info("starting worker (concurrency=%d)", cfg.worker_concurrency)

    sb = WorkerSupabase(cfg)
    listener = ScanQueueListener(cfg, sb)

    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()

    def _shutdown() -> None:
        log.info("shutdown signal received")
        stopping.set()
        asyncio.create_task(listener.stop())

    for sig_name in ("SIGINT", "SIGTERM"):
        try:
            loop.add_signal_handler(getattr(signal, sig_name), _shutdown)
        except (NotImplementedError, AttributeError):
            # Windows doesn't support add_signal_handler; rely on KeyboardInterrupt.
            pass

    listen_task = asyncio.create_task(listener.run())
    await stopping.wait()
    listen_task.cancel()
    try:
        await listen_task
    except asyncio.CancelledError:
        pass

    log.info("worker exited cleanly")


def main() -> None:
    try:
        asyncio.run(_main_async())
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()

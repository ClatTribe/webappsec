"""Tests for ScanQueueListener — Architecture.md §2.2 (concurrency, sweep).

ScanQueueListener.run() opens a real psycopg LISTEN connection, so the
end-to-end LISTEN flow is covered by manual / integration testing. These tests
exercise the parts that don't need a Postgres connection: the per-process
concurrency semaphore, the startup sweep, and dispatch error handling.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest

from strix_worker import listener as listener_mod
from strix_worker.config import WorkerConfig
from strix_worker.listener import ScanQueueListener


def _make_cfg(concurrency: int = 1) -> WorkerConfig:
    return WorkerConfig(
        supabase_url="http://localhost",
        supabase_service_role_key="fake",
        supabase_db_url="postgres://fake",
        default_strix_llm="openai/gpt-5.4",
        default_llm_api_key="sk-fake",
        strix_image="strix:test",
        strix_bin="/bin/true",
        worker_concurrency=concurrency,
        log_level="DEBUG",
        wrapper_origin=None,
    )


# --------------------------------------------------------------------------
# Stub Supabase client — minimal enough to satisfy _sweep_pending's chain.
# --------------------------------------------------------------------------

class _Result:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Query:
    """Implements the chain `.select(...).eq(...).order(...).limit(...).execute()`."""

    def __init__(self, data: list[dict[str, Any]]) -> None:
        self._data = data

    def select(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def eq(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def order(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def limit(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def execute(self) -> _Result:
        return _Result(self._data)


class _Client:
    def __init__(self, scans: list[dict[str, Any]] | None = None) -> None:
        self._scans = scans or []

    def table(self, name: str) -> _Query:
        if name == "scans":
            return _Query(self._scans)
        raise AssertionError(f"unexpected table: {name}")


class _StubSupabase:
    def __init__(self, queued: list[str] | None = None) -> None:
        self.client = _Client([{"id": sid} for sid in (queued or [])])


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrency_semaphore_bounds_in_flight_scans(monkeypatch):
    """§2.2: at most WORKER_CONCURRENCY scans run on a worker at any moment.

    Fire 10 dispatches concurrently against a listener configured for 3-way
    concurrency, while a stand-in run_scan tracks the high-water mark.
    """
    cfg = _make_cfg(concurrency=3)
    listener = ScanQueueListener(cfg, _StubSupabase())

    in_flight = 0
    high_water = 0
    lock = asyncio.Lock()

    async def slow_run_scan(scan_id, _cfg, _sb):  # type: ignore[no-untyped-def]
        nonlocal in_flight, high_water
        async with lock:
            in_flight += 1
            high_water = max(high_water, in_flight)
        try:
            await asyncio.sleep(0.05)
        finally:
            async with lock:
                in_flight -= 1

    monkeypatch.setattr(listener_mod, "run_scan", slow_run_scan)

    await asyncio.gather(*[listener._dispatch(f"scan-{i}") for i in range(10)])

    assert high_water == cfg.worker_concurrency, (
        f"observed {high_water} concurrent scans; expected ≤ {cfg.worker_concurrency}"
    )
    assert in_flight == 0


@pytest.mark.asyncio
async def test_dispatch_swallows_run_scan_exceptions(monkeypatch, caplog):
    """§2.2: a single failing scan must not break the listener loop."""
    cfg = _make_cfg(concurrency=1)
    listener = ScanQueueListener(cfg, _StubSupabase())

    async def boom(*_a, **_kw):  # type: ignore[no-untyped-def]
        raise RuntimeError("kaboom")

    monkeypatch.setattr(listener_mod, "run_scan", boom)

    with caplog.at_level(logging.ERROR, logger="strix_worker.listener"):
        await listener._dispatch("scan-1")  # must not raise

    assert any("dispatch failed" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_startup_sweep_redispatches_each_queued_scan(monkeypatch):
    """§2.2: _sweep_pending redispatches every scan still in 'queued' at startup."""
    cfg = _make_cfg()
    listener = ScanQueueListener(cfg, _StubSupabase(queued=["s1", "s2", "s3"]))

    dispatched: list[str] = []

    async def fake_dispatch(scan_id: str) -> None:
        dispatched.append(scan_id)

    listener._dispatch = fake_dispatch  # type: ignore[assignment]

    await listener._sweep_pending()

    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    assert sorted(dispatched) == ["s1", "s2", "s3"]


@pytest.mark.asyncio
async def test_startup_sweep_swallows_supabase_errors(monkeypatch, caplog):
    """§2.2: a failing sweep query is logged and ignored — listener still starts."""

    class _BrokenClient:
        def table(self, _name: str):  # type: ignore[no-untyped-def]
            raise RuntimeError("supabase down")

    class _BrokenSB:
        client = _BrokenClient()

    cfg = _make_cfg()
    listener = ScanQueueListener(cfg, _BrokenSB())  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING, logger="strix_worker.listener"):
        await listener._sweep_pending()  # must not raise

    assert any("sweep failed" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_listener_stop_sets_stopping_flag():
    """The stop() coroutine flips the internal event so run() can exit cleanly."""
    cfg = _make_cfg()
    listener = ScanQueueListener(cfg, _StubSupabase())
    assert not listener._stopping.is_set()
    await listener.stop()
    assert listener._stopping.is_set()

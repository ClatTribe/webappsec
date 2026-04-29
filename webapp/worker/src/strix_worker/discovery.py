"""Subdomain auto-discovery for `domain` targets.

When a user adds a domain target like `acme.com`, we hit
[crt.sh](https://crt.sh) — Certificate Transparency logs surfaced as JSON —
and write each unique subdomain we find into `target_discoveries`. The user
sees them on the target detail page and can promote ones they want scanned.

Why crt.sh as the only source for MVP:
  * Free, HTTP only, no auth, no binary install.
  * Decent coverage — every cert issued by Let's Encrypt / DigiCert /
    GlobalSign etc. lands in CT logs, so any subdomain that's ever had a
    public cert is visible.
  * Misses internal-only / never-served-publicly subdomains. We can stack
    `subfinder` later as a second source ([tools-wishlist.md] doesn't
    capture this yet; it's a fork-side ask).

The whole flow is best-effort. A crt.sh outage just means no discoveries
land for that target — the target itself is still scannable.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import quote

import httpx

from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)


CRT_SH_URL = "https://crt.sh/"
HTTP_TIMEOUT_SEC = 30.0
# Cap how many we write per target to keep one over-issued domain (e.g. some
# CDN's wildcard pattern that puts every customer subdomain under one cert)
# from ballooning the table. 250 is plenty for an SMB org's surface.
MAX_DISCOVERIES_PER_TARGET = 250

# crt.sh is famously flaky — 502 / 504 spikes during their sync runs are
# routine. Retry transient 5xx errors with exponential backoff before
# giving up. Doesn't affect 4xx (client errors don't get better with time).
HTTP_RETRY_DELAYS_SEC = (3, 10, 30)


async def discover_subdomains_for_target(
    sb: WorkerSupabase,
    target_id: str,
) -> int:
    """Hit crt.sh for the target's domain, write discoveries, return the count."""
    target = _fetch_target(sb, target_id)
    if target is None:
        logger.info("discovery: target %s not found, skipping", target_id)
        return 0
    if target.get("type") != "domain":
        logger.info(
            "discovery: target %s is %s, not domain, skipping",
            target_id, target.get("type"),
        )
        return 0

    domain = (target.get("value") or "").strip().lower()
    if not domain:
        return 0

    logger.info("discovery: querying crt.sh for %s (target %s)", domain, target_id)

    try:
        names = await _query_crt_sh(domain)
    except Exception:  # noqa: BLE001
        logger.exception("discovery: crt.sh query failed for %s", domain)
        return 0

    discovered = _normalise_subdomains(names, parent=domain)
    if not discovered:
        logger.info("discovery: no subdomains found for %s", domain)
        return 0

    inserted = _persist_discoveries(
        sb, target_id=target_id, org_id=target["org_id"], values=discovered,
    )
    logger.info(
        "discovery: %d new subdomains for %s (total seen: %d)",
        inserted, domain, len(discovered),
    )
    return inserted


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_target(sb: WorkerSupabase, target_id: str) -> dict[str, Any] | None:
    try:
        result = (
            sb.client.table("targets")
            .select("id, org_id, type, value")
            .eq("id", target_id)
            .single()
            .execute()
        )
        return result.data
    except Exception:  # noqa: BLE001
        return None


async def _query_crt_sh(domain: str) -> list[str]:
    """Returns the union of `name_value` and `common_name` fields from crt.sh.

    Retries transient 5xx and timeout errors with exponential backoff —
    crt.sh's 502 windows during their sync runs typically clear in a
    minute or two, well within our retry budget.
    """
    params = {"q": f"%.{domain}", "output": "json"}
    rows: list[dict[str, str]] | None = None

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SEC) as client:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((0.0, *HTTP_RETRY_DELAYS_SEC)):
            if delay:
                await asyncio.sleep(delay)
            try:
                response = await client.get(CRT_SH_URL, params=params)
                # 4xx → don't retry (won't get better; either bad query or
                # crt.sh changed shape). 5xx and timeouts → retry.
                if 500 <= response.status_code < 600:
                    raise httpx.HTTPStatusError(
                        f"crt.sh transient {response.status_code}",
                        request=response.request,
                        response=response,
                    )
                response.raise_for_status()
                rows = response.json()
                break
            except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ReadError) as e:
                last_exc = e
                logger.info(
                    "crt.sh attempt %d failed for %s (%s); %s",
                    attempt + 1,
                    domain,
                    e.__class__.__name__,
                    "retrying" if attempt < len(HTTP_RETRY_DELAYS_SEC) else "giving up",
                )
        if rows is None:
            assert last_exc is not None
            raise last_exc

    names: set[str] = set()
    for row in rows or []:
        # `name_value` is a newline-separated list of SANs on the cert.
        name_value = row.get("name_value") or ""
        for line in name_value.splitlines():
            n = line.strip().lower()
            if n:
                names.add(n)
        cn = (row.get("common_name") or "").strip().lower()
        if cn:
            names.add(cn)
    return sorted(names)


def _normalise_subdomains(names: list[str], *, parent: str) -> list[str]:
    """Filter, dedupe, and cap the raw crt.sh output."""
    out: list[str] = []
    seen: set[str] = set()
    parent = parent.lower().strip()

    for name in names:
        n = name.strip().lower().rstrip(".")
        if not n or n in seen:
            continue
        # Drop wildcards — they're a class, not a host.
        if n.startswith("*."):
            n = n[2:]
            if not n or n in seen:
                continue
        # Sanity: must end in the parent domain.
        if not (n == parent or n.endswith("." + parent)):
            continue
        # Drop the parent itself — already a target.
        if n == parent:
            continue
        # Drop email-style entries that crt.sh sometimes returns.
        if "@" in n:
            continue
        seen.add(n)
        out.append(n)

    out.sort()
    return out[:MAX_DISCOVERIES_PER_TARGET]


def _persist_discoveries(
    sb: WorkerSupabase,
    *,
    target_id: str,
    org_id: str,
    values: list[str],
) -> int:
    """Upsert each discovery. Returns count of *new* rows inserted (vs updated)."""
    payload = [
        {
            "target_id": target_id,
            "org_id": org_id,
            "source": "crt_sh",
            "value": value,
        }
        for value in values
    ]
    if not payload:
        return 0

    # We can't easily count "new vs updated" via the supabase-py upsert API,
    # so fall back to a SELECT first → diff → INSERT only the new ones. The
    # status of an existing row (pending / accepted / dismissed) must be
    # preserved across re-discovery runs — overwriting with `pending` would
    # un-dismiss things the user already curated.
    existing_q = (
        sb.client.table("target_discoveries")
        .select("value, last_seen_at")
        .eq("target_id", target_id)
        .execute()
    )
    existing = {row["value"] for row in (existing_q.data or [])}
    new_payload = [r for r in payload if r["value"] not in existing]

    if new_payload:
        sb.client.table("target_discoveries").insert(new_payload).execute()

    # Bump last_seen_at on the rows that were already there.
    if existing:
        sb.client.rpc(
            "exec_raw",
            None,  # not needed; we'll just use REST update below
        ) if False else None
        # Plain update: easier to read than the RPC dance.
        try:
            (
                sb.client.table("target_discoveries")
                .update({"last_seen_at": "now()"})
                .eq("target_id", target_id)
                .in_("value", list(existing))
                .execute()
            )
        except Exception:  # noqa: BLE001
            # last_seen_at bump is informational; never fail discovery on it.
            logger.debug("discovery: last_seen_at bump failed", exc_info=True)

    return len(new_payload)

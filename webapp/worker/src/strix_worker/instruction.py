"""Build the final --instruction string passed to Strix.

The wrapper carries typed per-target-type configuration in `targets.config`
(roadmap §9.1). Strix's CLI today is thin — `-t`, `-m`, `--instruction`,
`--scope-mode`, `--diff-base`. So most of `targets.config` ends up encoded as
augmented natural-language text appended to the user's free-form
`scan.instruction_text` and passed via `--instruction`.

Where this works (~80% of cases): branch / subdirectory / language hints /
crawl seeds / port specs — any field the agent can read and act on by
reading documentation. Where it doesn't (the 20% we ask Strix for in
[`tools-wishlist.md`]): hard rate-limits, exclude-paths the agent must
NEVER hit, credentials that shouldn't end up in events.jsonl. For those
we want real CLI flags upstream; until they land, augmented instruction is
what we have.

Drift between this file and `webapp/frontend/lib/target-config.ts` is a
real bug — the test suite uses the same field names to catch it.
"""

from __future__ import annotations

from typing import Any


def build_instruction(scan: dict[str, Any]) -> str | None:
    """Combine the user's free-form instruction with per-target augmentation.

    Returns the full text to pass via Strix's --instruction, or None if
    there's nothing to say. The user's text comes first so the agent sees
    intent before fine-print.
    """
    parts: list[str] = []

    user_text = (scan.get("instruction_text") or "").strip()
    if user_text:
        parts.append(user_text)

    parent = scan.get("targets") or {}
    target_type = parent.get("type")
    config = parent.get("config") or {}

    augmented = _augment_for_type(target_type, config)
    if augmented:
        parts.append("Additional configuration for this target:")
        parts.extend(f"- {line}" for line in augmented)

    if not parts:
        return None
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Per-type augmenters
# ---------------------------------------------------------------------------


def _augment_for_type(target_type: str | None, config: dict[str, Any]) -> list[str]:
    if not target_type or not isinstance(config, dict) or not config:
        return []
    augmenter = _AUGMENTERS.get(target_type)
    if augmenter is None:
        return []
    return augmenter(config)


def _augment_repository(config: dict[str, Any]) -> list[str]:
    out: list[str] = []
    branch = config.get("branch")
    if isinstance(branch, str) and branch.strip():
        out.append(f"Use the `{branch.strip()}` branch.")
    subdirectory = config.get("subdirectory")
    if isinstance(subdirectory, str) and subdirectory.strip():
        out.append(
            f"Focus the analysis on the `{subdirectory.strip()}` "
            "subdirectory only."
        )
    return out


def _augment_web_application(config: dict[str, Any]) -> list[str]:
    out: list[str] = []
    seeds = config.get("crawl_seeds")
    if isinstance(seeds, list) and seeds:
        urls = ", ".join(s for s in seeds if isinstance(s, str) and s.strip())
        if urls:
            out.append(f"Begin crawling from these URLs: {urls}.")
    qps = config.get("rate_limit_qps")
    if isinstance(qps, int) and qps > 0:
        out.append(
            f"Do not exceed {qps} requests per second total — this is "
            "production traffic, treat it accordingly."
        )
    return out


def _augment_domain(config: dict[str, Any]) -> list[str]:
    out: list[str] = []
    excludes = config.get("subdomain_excludes")
    if isinstance(excludes, list) and excludes:
        joined = ", ".join(s for s in excludes if isinstance(s, str) and s.strip())
        if joined:
            out.append(
                f"Skip subdomains matching any of these patterns: {joined}."
            )
    return out


def _augment_ip_address(config: dict[str, Any]) -> list[str]:
    out: list[str] = []
    ports = config.get("port_spec")
    if isinstance(ports, str) and ports.strip():
        out.append(f"Scan only these ports: {ports.strip()}.")
    proto = config.get("protocols")
    if isinstance(proto, str) and proto in {"tcp", "udp", "both"}:
        if proto == "both":
            out.append("Scan both TCP and UDP services.")
        else:
            out.append(f"Limit scanning to {proto.upper()} services.")
    return out


def _augment_local_code(config: dict[str, Any]) -> list[str]:
    out: list[str] = []
    excludes = config.get("path_excludes")
    if isinstance(excludes, list) and excludes:
        joined = ", ".join(p for p in excludes if isinstance(p, str) and p.strip())
        if joined:
            out.append(f"Ignore these paths: {joined}.")
    hints = config.get("language_hints")
    if isinstance(hints, list) and hints:
        joined = ", ".join(h for h in hints if isinstance(h, str) and h.strip())
        if joined:
            out.append(
                f"This codebase is primarily {joined}; prime your static analysis accordingly."
            )
    return out


_AUGMENTERS = {
    "repository": _augment_repository,
    "web_application": _augment_web_application,
    "domain": _augment_domain,
    "ip_address": _augment_ip_address,
    "local_code": _augment_local_code,
}

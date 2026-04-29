"""SQL-layer workflow tests against a live local Supabase Postgres.

These exercise the behaviours documented in:

  - Architecture.md §2.1   pg_notify trigger fires on scan_queued insert
  - Architecture.md §3.2   RLS isolates scans, integrations, and audit_log per org
  - Architecture.md §3.3   custom_access_token_hook injects org_id and validates membership
  - Architecture.md §3.4   vault_create_secret is service-role only
  - Architecture.md §3.5   worker_decrypt_integration enforces org match + scan-link + audits

Tests skip cleanly when the local DB is unreachable. To run them:

    cd webapp/supabase
    supabase start && supabase db reset

    cd ../worker
    SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres \\
        uv run pytest tests/test_supabase_workflows.py -v

Each test runs in its own transaction and rolls back on teardown — nothing is
committed to the local database.
"""

from __future__ import annotations

import json
import os
import uuid

import pytest

try:
    import psycopg
    from psycopg import errors as pg_errors
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore[assignment]
    pg_errors = None  # type: ignore[assignment]


DB_URL = os.environ.get(
    "SUPABASE_DB_URL",
    "postgresql://postgres:postgres@localhost:54322/postgres",
)


def _try_connect() -> "psycopg.Connection | None":
    if psycopg is None:
        return None
    try:
        return psycopg.connect(DB_URL, autocommit=False, connect_timeout=2)
    except Exception:  # noqa: BLE001
        return None


@pytest.fixture
def conn():
    """Yield a Postgres connection; rollback on teardown so tests don't pollute the DB."""
    c = _try_connect()
    if c is None:
        pytest.skip(f"local Supabase Postgres not reachable at {DB_URL}")
    try:
        yield c
    finally:
        c.rollback()
        c.close()


# ---------------------------------------------------------------------------
# Helpers — switch JWT context, seed test users/orgs, etc.
# ---------------------------------------------------------------------------


def _set_jwt(cur, *, sub: str, org_id: str | None = None, jwt_role: str = "authenticated") -> None:
    """Spoof a Supabase JWT for the rest of this transaction."""
    claims: dict[str, str] = {"sub": sub, "role": jwt_role}
    if org_id is not None:
        claims["org_id"] = org_id
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true)", (json.dumps(claims),)
    )
    cur.execute(f"SET LOCAL ROLE {jwt_role}")


def _reset_role(cur) -> None:
    cur.execute("RESET ROLE")
    cur.execute("SELECT set_config('request.jwt.claims', '', true)")


def _seed_two_orgs(cur) -> dict[str, str]:
    """Create alice in org_a (owner) and bob in org_b (owner). Returns their IDs.

    Emails are suffixed with a random tag because some functions called inside
    the tests (e.g. vault.create_secret) commit internally, which can persist
    the seed rows even if later test logic fails. Unique emails keep tests
    independent of leftover state.
    """
    alice = uuid.uuid4()
    bob = uuid.uuid4()
    org_a = uuid.uuid4()
    org_b = uuid.uuid4()
    tag = uuid.uuid4().hex[:8]

    cur.execute(
        "INSERT INTO auth.users (id, email) VALUES (%s, %s), (%s, %s)",
        (alice, f"alice-{tag}@a.test", bob, f"bob-{tag}@b.test"),
    )
    cur.execute(
        "INSERT INTO public.organizations (id, name, slug) "
        "VALUES (%s, 'A', 'a-' || %s), (%s, 'B', 'b-' || %s)",
        (org_a, str(org_a)[:8], org_b, str(org_b)[:8]),
    )
    cur.execute(
        "INSERT INTO public.org_members (user_id, org_id, role) "
        "VALUES (%s, %s, 'owner'), (%s, %s, 'owner')",
        (alice, org_a, bob, org_b),
    )
    return {
        "alice": str(alice),
        "bob": str(bob),
        "org_a": str(org_a),
        "org_b": str(org_b),
    }


# ===========================================================================
# §2.1 — pg_notify trigger
# ===========================================================================


def test_pg_notify_trigger_function_exists_and_is_attached(conn):
    """notify_scan_queued is wired up as an AFTER INSERT trigger on public.scans."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM pg_trigger "
            "WHERE tgrelid = 'public.scans'::regclass "
            "  AND tgname = 'scans_queued_notify' "
            "  AND NOT tgisinternal"
        )
        assert cur.fetchone()[0] == 1


def test_pg_notify_fires_on_scan_insert(conn):
    """A separate listening connection receives the scan id when one is inserted."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with listener.cursor() as lc:
            lc.execute("LISTEN scan_queued")

        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            scan_id = uuid.uuid4()
            cur.execute(
                "INSERT INTO public.scans (id, org_id, user_id, run_name, status) "
                "VALUES (%s, %s, %s, 'test-notify', 'queued')",
                (scan_id, ids["org_a"], ids["alice"]),
            )
            conn.commit()

        received: list[str] = []
        gen = listener.notifies(timeout=2.0)
        for n in gen:
            received.append(n.payload)
            break

        assert str(scan_id) in received
    finally:
        listener.close()


# ===========================================================================
# §3.3 — custom_access_token_hook
# ===========================================================================


def test_jwt_hook_injects_org_id_for_member(conn):
    """First-login flow: user has no org_id claim → hook fills in their primary org."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        cur.execute(
            "SELECT public.custom_access_token_hook(%s::jsonb)",
            (json.dumps({"user_id": ids["alice"], "claims": {}}),),
        )
        result = cur.fetchone()[0]
        assert result["claims"]["org_id"] == ids["org_a"]
        assert result["claims"]["org_role"] == "owner"


def test_jwt_hook_honors_valid_org_switch(conn):
    """Org-switch flow: user requests an org they're a member of → hook keeps their choice."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        # Alice is also a member of org_b.
        cur.execute(
            "INSERT INTO public.org_members (user_id, org_id, role) VALUES (%s, %s, 'admin')",
            (ids["alice"], ids["org_b"]),
        )
        cur.execute(
            "SELECT public.custom_access_token_hook(%s::jsonb)",
            (json.dumps({"user_id": ids["alice"], "claims": {"org_id": ids["org_b"]}}),),
        )
        result = cur.fetchone()[0]
        assert result["claims"]["org_id"] == ids["org_b"]
        assert result["claims"]["org_role"] == "admin"


def test_jwt_hook_ignores_unauthorized_org_override(conn):
    """Tampered token: user requests an org they aren't in → hook falls back to their actual org."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        cur.execute(
            "SELECT public.custom_access_token_hook(%s::jsonb)",
            (json.dumps({"user_id": ids["alice"], "claims": {"org_id": ids["org_b"]}}),),
        )
        result = cur.fetchone()[0]
        assert result["claims"]["org_id"] == ids["org_a"]


# ===========================================================================
# §3.2 — RLS isolation
# ===========================================================================


def test_rls_alice_cannot_see_bob_scans(conn):
    """Two-tenant query isolation: a member of org A sees zero rows from org B."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        cur.execute(
            "INSERT INTO public.scans (org_id, user_id, run_name) VALUES (%s, %s, 'bob-scan')",
            (ids["org_b"], ids["bob"]),
        )

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        cur.execute("SELECT count(*) FROM public.scans")
        assert cur.fetchone()[0] == 0

    # Reset for the symmetric check.
    conn.rollback()
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        cur.execute(
            "INSERT INTO public.scans (org_id, user_id, run_name) VALUES (%s, %s, 'bob-scan')",
            (ids["org_b"], ids["bob"]),
        )

        _set_jwt(cur, sub=ids["bob"], org_id=ids["org_b"])
        cur.execute("SELECT count(*) FROM public.scans")
        assert cur.fetchone()[0] == 1


def test_rls_blocks_inserting_scan_into_other_org(conn):
    """A user can't forge a scan into someone else's org by setting org_id in the body."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])

        with pytest.raises(pg_errors.InsufficientPrivilege):
            cur.execute(
                "INSERT INTO public.scans (org_id, user_id, run_name) "
                "VALUES (%s, %s, 'cross-tenant-attempt')",
                (ids["org_b"], ids["alice"]),
            )


def test_rls_member_cannot_revoke_integration(conn):
    """integrations_org_delete RLS limits DELETE to owner/admin — member is rejected."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)

        cur.execute("SELECT vault.create_secret('plaintext', 'test', 'desc')")
        secret_id = cur.fetchone()[0]

        cur.execute(
            "INSERT INTO public.integrations "
            "  (org_id, type, name, vault_secret_id, created_by) "
            "VALUES (%s, 'github', 'g', %s, %s) RETURNING id",
            (ids["org_a"], secret_id, ids["alice"]),
        )
        integration_id = cur.fetchone()[0]

        cur.execute(
            "UPDATE public.org_members SET role = 'member' WHERE user_id = %s",
            (ids["alice"],),
        )

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        cur.execute("DELETE FROM public.integrations WHERE id = %s", (integration_id,))
        # RLS makes the delete a no-op — the row is still present.
        assert cur.rowcount == 0

        _reset_role(cur)
        cur.execute(
            "SELECT count(*) FROM public.integrations WHERE id = %s", (integration_id,)
        )
        assert cur.fetchone()[0] == 1


def test_rls_audit_log_admin_only_read(conn):
    """audit_log is admin/owner read-only — a regular member sees nothing."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        cur.execute(
            "INSERT INTO public.audit_log (org_id, user_id, action) VALUES (%s, %s, 'test')",
            (ids["org_a"], ids["alice"]),
        )
        cur.execute(
            "UPDATE public.org_members SET role = 'member' WHERE user_id = %s",
            (ids["alice"],),
        )

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        cur.execute("SELECT count(*) FROM public.audit_log")
        assert cur.fetchone()[0] == 0


# ===========================================================================
# §3.4 — vault_create_secret service-role gate
# ===========================================================================


def test_vault_create_secret_rejects_anon_role(conn):
    """vault_create_secret is unreachable to anon/authenticated callers.

    Two layers of defence: the GRANT was REVOKEd from authenticated/anon, AND
    the function body checks `auth.role() = 'service_role'`. When called as
    authenticated, the GRANT denial fires first (InsufficientPrivilege).
    """
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="authenticated")

        with pytest.raises(
            (psycopg.errors.InsufficientPrivilege, psycopg.errors.RaiseException)
        ):
            cur.execute(
                "SELECT public.vault_create_secret('plaintext', 'name', 'desc')"
            )


# ===========================================================================
# §3.5 — worker_decrypt_integration enforcement
# ===========================================================================


def _setup_decrypt_scenario(cur, ids: dict[str, str]) -> dict[str, str]:
    """Seed an integration in org_a and a scan in org_a, optionally linked."""
    cur.execute("SELECT vault.create_secret('plaintext-secret', 'gh', 'desc')")
    secret_id = cur.fetchone()[0]

    cur.execute(
        "INSERT INTO public.integrations "
        "  (org_id, type, name, vault_secret_id, created_by) "
        "VALUES (%s, 'github', 'gh-org-a', %s, %s) RETURNING id",
        (ids["org_a"], secret_id, ids["alice"]),
    )
    integration_id = cur.fetchone()[0]

    cur.execute(
        "INSERT INTO public.scans (org_id, user_id, run_name) VALUES (%s, %s, 'scan-a') RETURNING id",
        (ids["org_a"], ids["alice"]),
    )
    scan_id = cur.fetchone()[0]

    return {"integration_id": str(integration_id), "scan_id": str(scan_id)}


def test_decrypt_integration_succeeds_with_proper_link_and_audits(conn):
    """The good path: org match + scan_integrations link present → returns plaintext + audits."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        env = _setup_decrypt_scenario(cur, ids)

        cur.execute(
            "INSERT INTO public.scan_integrations (scan_id, integration_id) VALUES (%s, %s)",
            (env["scan_id"], env["integration_id"]),
        )

        cur.execute(
            "SELECT public.worker_decrypt_integration(%s, %s)",
            (env["scan_id"], env["integration_id"]),
        )
        plaintext = cur.fetchone()[0]
        assert plaintext == "plaintext-secret"

        cur.execute(
            "SELECT count(*) FROM public.audit_log "
            "WHERE action = 'integration.use' AND resource_id = %s",
            (env["integration_id"],),
        )
        assert cur.fetchone()[0] == 1

        cur.execute(
            "SELECT last_used_at IS NOT NULL FROM public.integrations WHERE id = %s",
            (env["integration_id"],),
        )
        assert cur.fetchone()[0] is True


def test_decrypt_integration_blocks_missing_scan_link(conn):
    """Integration belongs to the same org as the scan, but no scan_integrations row → reject."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        env = _setup_decrypt_scenario(cur, ids)
        # Deliberately do NOT insert into scan_integrations.

        with pytest.raises(psycopg.errors.RaiseException, match="not linked"):
            cur.execute(
                "SELECT public.worker_decrypt_integration(%s, %s)",
                (env["scan_id"], env["integration_id"]),
            )


def test_decrypt_integration_blocks_cross_org_scan(conn):
    """Decrypting integration in org A using a scan in org B → reject before vault read."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        env = _setup_decrypt_scenario(cur, ids)
        # A scan owned by Bob's org, with no link to alice's integration.
        cur.execute(
            "INSERT INTO public.scans (org_id, user_id, run_name) VALUES (%s, %s, 'b-scan') RETURNING id",
            (ids["org_b"], ids["bob"]),
        )
        bob_scan = cur.fetchone()[0]

        with pytest.raises(psycopg.errors.RaiseException, match="does not belong"):
            cur.execute(
                "SELECT public.worker_decrypt_integration(%s, %s)",
                (bob_scan, env["integration_id"]),
            )


def test_decrypt_integration_requires_service_role(conn):
    """Even with valid IDs, a non-service-role caller is blocked."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        env = _setup_decrypt_scenario(cur, ids)
        cur.execute(
            "INSERT INTO public.scan_integrations (scan_id, integration_id) VALUES (%s, %s)",
            (env["scan_id"], env["integration_id"]),
        )

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "SELECT public.worker_decrypt_integration(%s, %s)",
                (env["scan_id"], env["integration_id"]),
            )


# ===========================================================================
# Roadmap §1 — scan-lifecycle RPCs (claim, heartbeat, sweep, cancel)
# ===========================================================================


def _seed_queued_scan(cur, org_id: str, user_id: str, run_name: str = "test-scan") -> str:
    cur.execute(
        "INSERT INTO public.scans (org_id, user_id, run_name, status) "
        "VALUES (%s, %s, %s, 'queued') RETURNING id",
        (org_id, user_id, run_name),
    )
    return str(cur.fetchone()[0])


def test_worker_claim_scan_returns_row_when_queued(conn):
    """Atomic claim: a single worker claiming a queued scan gets the row."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute("SELECT (public.worker_claim_scan(%s)).id", (scan_id,))
        row = cur.fetchone()
        assert row is not None and str(row[0]) == scan_id

        # Side effects: status, started_at, last_heartbeat_at all set.
        cur.execute(
            "SELECT status, started_at, last_heartbeat_at FROM public.scans WHERE id = %s",
            (scan_id,),
        )
        status, started_at, hb = cur.fetchone()
        assert status == "running"
        assert started_at is not None
        assert hb is not None


def test_worker_claim_scan_returns_null_when_already_running(conn):
    """The atomicity guarantee: a second claim of the same scan must return
    null so a second worker doesn't dispatch a duplicate run."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        # First claim wins.
        cur.execute("SELECT (public.worker_claim_scan(%s)).id", (scan_id,))
        first = cur.fetchone()[0]
        assert first is not None

        # Second claim — row is now 'running', UPDATE matches nothing.
        cur.execute("SELECT (public.worker_claim_scan(%s)).id", (scan_id,))
        second = cur.fetchone()[0]
        assert second is None


def test_worker_claim_scan_requires_service_role(conn):
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        with pytest.raises(pg_errors.InsufficientPrivilege):
            cur.execute("SELECT public.worker_claim_scan(%s)", (scan_id,))


def test_worker_heartbeat_scan_advances_timestamp(conn):
    """Successive heartbeat calls bump last_heartbeat_at — the stale-scan
    sweep relies on this column moving forward."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute("SELECT public.worker_claim_scan(%s)", (scan_id,))

        cur.execute(
            "SELECT last_heartbeat_at FROM public.scans WHERE id = %s", (scan_id,)
        )
        first = cur.fetchone()[0]

        # Force time to advance and call heartbeat again.
        cur.execute("SELECT pg_sleep(0.05)")
        cur.execute("SELECT public.worker_heartbeat_scan(%s)", (scan_id,))

        cur.execute(
            "SELECT last_heartbeat_at FROM public.scans WHERE id = %s", (scan_id,)
        )
        second = cur.fetchone()[0]
        assert second > first


def test_worker_heartbeat_noop_on_terminal_scan(conn):
    """A heartbeat that arrives after the scan was already finished must not
    resurrect the row — the WHERE clause filters on status='running'."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute("SELECT public.worker_claim_scan(%s)", (scan_id,))
        cur.execute(
            "UPDATE public.scans SET status = 'completed' WHERE id = %s", (scan_id,)
        )

        cur.execute(
            "SELECT last_heartbeat_at FROM public.scans WHERE id = %s", (scan_id,)
        )
        before = cur.fetchone()[0]

        cur.execute("SELECT pg_sleep(0.05)")
        cur.execute("SELECT public.worker_heartbeat_scan(%s)", (scan_id,))

        cur.execute(
            "SELECT last_heartbeat_at, status FROM public.scans WHERE id = %s",
            (scan_id,),
        )
        after_hb, after_status = cur.fetchone()
        assert after_hb == before  # unchanged
        assert after_status == "completed"  # not flipped back


def test_mark_stale_scans_flips_silent_running_rows_to_failed(conn):
    """Sweep: a 'running' scan whose last_heartbeat_at is older than the
    tolerance gets flipped to 'failed' with a descriptive error_message."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute("SELECT public.worker_claim_scan(%s)", (scan_id,))
        # Backdate the heartbeat into the past so the sweep finds it.
        cur.execute(
            "UPDATE public.scans SET last_heartbeat_at = now() - interval '20 minutes' "
            "WHERE id = %s",
            (scan_id,),
        )

        cur.execute("SELECT public.mark_stale_scans(600)")  # 10-min tolerance
        sweept = [str(r[0]) for r in cur.fetchall()]
        assert scan_id in sweept

        cur.execute(
            "SELECT status, error_message FROM public.scans WHERE id = %s", (scan_id,)
        )
        status, err = cur.fetchone()
        assert status == "failed"
        assert err is not None and "heartbeat stopped" in err


def test_mark_stale_scans_leaves_fresh_runs_alone(conn):
    """A scan with a recent heartbeat must not be reaped — that would make
    the sweep an availability bug."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute("SELECT public.worker_claim_scan(%s)", (scan_id,))

        cur.execute("SELECT public.mark_stale_scans(600)")
        sweept = [str(r[0]) for r in cur.fetchall()]
        assert scan_id not in sweept

        cur.execute("SELECT status FROM public.scans WHERE id = %s", (scan_id,))
        assert cur.fetchone()[0] == "running"


def test_request_scan_cancel_sets_flag_and_notifies(conn):
    """User pressing Cancel: cancel_requested_at is set and a notification
    fires on the `scan_cancel` channel for the worker to pick up."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with listener.cursor() as lc:
            lc.execute("LISTEN scan_cancel")

        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            cur.execute("SELECT public.request_scan_cancel(%s)", (scan_id,))
            conn.commit()  # release for NOTIFY delivery

            cur.execute(
                "SELECT cancel_requested_at FROM public.scans WHERE id = %s", (scan_id,)
            )
            assert cur.fetchone()[0] is not None

            received = []
            for n in listener.notifies(timeout=2.0):
                received.append((n.channel, n.payload))
                break
            assert ("scan_cancel", scan_id) in received
    finally:
        listener.close()


def test_request_scan_cancel_requires_org_membership(conn):
    """A user from a different org must not be able to cancel another org's
    scan — that's a tenancy escape."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])

        # Bob from org_b tries to cancel alice's scan.
        _set_jwt(cur, sub=ids["bob"], org_id=ids["org_b"])
        with pytest.raises(pg_errors.RaiseException, match="not a member"):
            cur.execute("SELECT public.request_scan_cancel(%s)", (scan_id,))


def test_request_scan_cancel_is_noop_on_terminal_scan(conn):
    """Pressing Cancel on a scan that already finished must be a quiet no-op
    (concurrent click + auto-finish race)."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        scan_id = _seed_queued_scan(cur, ids["org_a"], ids["alice"])
        cur.execute(
            "UPDATE public.scans SET status = 'completed' WHERE id = %s", (scan_id,)
        )

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        # No exception, no row change.
        cur.execute("SELECT public.request_scan_cancel(%s)", (scan_id,))

        cur.execute(
            "SELECT cancel_requested_at, status FROM public.scans WHERE id = %s",
            (scan_id,),
        )
        cancelled_at, status = cur.fetchone()
        assert cancelled_at is None
        assert status == "completed"


# ===========================================================================
# create_scan_with_targets — atomic scan creation that closes the race
# between INSERT INTO scans (which fires pg_notify) and INSERT INTO
# scan_targets (which the worker needs to invoke Strix correctly).
# ===========================================================================


def test_create_scan_with_targets_inserts_atomically(conn):
    """Single RPC call → scan + scan_targets + integrations all visible
    at commit time. Without this, the worker could fetch a target-less
    scan and silently fail the run."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])

        cur.execute(
            "SELECT public.create_scan_with_targets("
            "  %s::uuid, %s, %s, %s, %s, %s, %s::uuid, %s::jsonb, %s::uuid[]"
            ")",
            (
                ids["org_a"],
                "test-atomic-scan",
                "quick",
                "auto",
                None,
                "passive recon",
                None,
                json.dumps(
                    [
                        {"type": "domain", "value": "example.com", "workspace_subdir": "t1"},
                        {"type": "domain", "value": "example.org"},
                    ]
                ),
                [],
            ),
        )
        scan_id = cur.fetchone()[0]
        assert scan_id is not None

        # Both targets land before commit; second target's workspace_subdir
        # auto-fills to `target_2` from the array index.
        cur.execute(
            "SELECT type, value, workspace_subdir FROM public.scan_targets "
            "WHERE scan_id = %s ORDER BY workspace_subdir",
            (scan_id,),
        )
        rows = cur.fetchall()
        assert rows == [
            ("domain", "example.com", "t1"),
            ("domain", "example.org", "target_2"),
        ]

        cur.execute(
            "SELECT status, run_name FROM public.scans WHERE id = %s", (scan_id,)
        )
        status, run_name = cur.fetchone()
        assert status == "queued"
        assert run_name == "test-atomic-scan"


def test_create_scan_with_targets_notify_fires_with_targets_visible(conn):
    """The pg_notify-then-fetch-empty race the RPC was built to fix:
    a separate listening connection that wakes on `scan_queued` must see
    the scan_targets row. Without atomicity, the LISTEN delivers before
    scan_targets has even been inserted."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with listener.cursor() as lc:
            lc.execute("LISTEN scan_queued")

        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])

            cur.execute(
                "SELECT public.create_scan_with_targets("
                "  %s::uuid, %s, %s, %s, %s, %s, %s::uuid, %s::jsonb, %s::uuid[]"
                ")",
                (
                    ids["org_a"],
                    "race-test",
                    "quick",
                    "auto",
                    None,
                    None,
                    None,
                    json.dumps([{"type": "domain", "value": "example.com"}]),
                    [],
                ),
            )
            scan_id = cur.fetchone()[0]
            conn.commit()  # release notification

            # The listener now sees scan_queued. By the contract the RPC
            # gives, scan_targets is already populated for that id.
            received = []
            for n in listener.notifies(timeout=2.0):
                received.append(n.payload)
                break
            assert str(scan_id) in received

            # Critical: the joined view the worker queries returns >= 1 target.
            with listener.cursor() as lc:
                lc.execute(
                    "SELECT count(*) FROM public.scan_targets WHERE scan_id = %s",
                    (scan_id,),
                )
                assert lc.fetchone()[0] >= 1
    finally:
        listener.close()


def test_create_scan_with_targets_rejects_empty_targets(conn):
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])

        with pytest.raises(pg_errors.RaiseException, match="at least one target"):
            cur.execute(
                "SELECT public.create_scan_with_targets("
                "  %s::uuid, %s, %s, %s, %s, %s, %s::uuid, %s::jsonb, %s::uuid[]"
                ")",
                (
                    ids["org_a"],
                    "empty",
                    "quick",
                    "auto",
                    None,
                    None,
                    None,
                    json.dumps([]),
                    [],
                ),
            )


def test_create_scan_with_targets_rls_blocks_cross_org_insert(conn):
    """Bob can't create a scan in Alice's org — RLS on the scans insert
    rejects it. The RPC runs as security invoker so the user's RLS applies."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["bob"], org_id=ids["org_b"])

        with pytest.raises((pg_errors.InsufficientPrivilege, pg_errors.RaiseException)):
            cur.execute(
                "SELECT public.create_scan_with_targets("
                "  %s::uuid, %s, %s, %s, %s, %s, %s::uuid, %s::jsonb, %s::uuid[]"
                ")",
                (
                    ids["org_a"],  # bob targeting alice's org
                    "cross-org",
                    "quick",
                    "auto",
                    None,
                    None,
                    None,
                    json.dumps([{"type": "domain", "value": "evil.example"}]),
                    [],
                ),
            )


# ===========================================================================
# Subdomain auto-discovery — roadmap §9.
#
# The worker hits crt.sh on `target_discovery_requested` and writes rows to
# target_discoveries. The user then accepts (→ promote to a real target) or
# dismisses each one. Tests below exercise the SQL surface: the trigger, the
# promote RPC, RLS, and idempotency.
# ===========================================================================


def _seed_domain_target(
    cur, org_id: str, user_id: str, value: str = "acme.com",
    auto_discover: bool = True,
) -> str:
    """Insert a domain target. auto_discover defaults to True here so the
    existing tests that exercise the discovery flow still see the notify;
    the flag's own behaviour is exercised by the dedicated tests below."""
    cur.execute(
        "INSERT INTO public.targets (org_id, name, type, value, created_by, auto_discover) "
        "VALUES (%s, %s, 'domain', %s, %s, %s) RETURNING id",
        (org_id, value, value, user_id, auto_discover),
    )
    return str(cur.fetchone()[0])


def test_target_insert_fires_discovery_notify_when_opted_in(conn):
    """A new domain target with auto_discover=true fires the notify."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with listener.cursor() as lc:
            lc.execute("LISTEN target_discovery_requested")

        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            target_id = _seed_domain_target(
                cur, ids["org_a"], ids["alice"], auto_discover=True,
            )
            conn.commit()

            received = []
            for n in listener.notifies(timeout=2.0):
                received.append(n.payload)
                break
            assert target_id in received
    finally:
        listener.close()


def test_target_insert_does_not_fire_discovery_when_opted_out(conn):
    """Domain target with auto_discover=false (the default) is silent —
    the user gets the target without paying for crt.sh enumeration."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with listener.cursor() as lc:
            lc.execute("LISTEN target_discovery_requested")

        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            _seed_domain_target(
                cur, ids["org_a"], ids["alice"], auto_discover=False,
            )
            conn.commit()

            received = []
            for n in listener.notifies(timeout=0.5):
                received.append(n.payload)
            assert received == []
    finally:
        listener.close()


def test_target_update_fires_discovery_when_flag_flipped_on(conn):
    """User flips auto_discover from false → true on an existing target.
    The UPDATE trigger fires the notify so the worker enumerates without
    requiring the user to delete and recreate the target."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            target_id = _seed_domain_target(
                cur, ids["org_a"], ids["alice"], auto_discover=False,
            )
            conn.commit()

        # Now subscribe — we don't want the (silent) insert to confuse us.
        with listener.cursor() as lc:
            lc.execute("LISTEN target_discovery_requested")

        with conn.cursor() as cur:
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            cur.execute(
                "UPDATE public.targets SET auto_discover = true WHERE id = %s",
                (target_id,),
            )
            conn.commit()

            received = []
            for n in listener.notifies(timeout=2.0):
                received.append(n.payload)
                break
            assert target_id in received
    finally:
        listener.close()


def test_target_update_does_not_fire_when_flag_flipped_off(conn):
    """auto_discover true → false should NOT fire (nothing to do)."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            target_id = _seed_domain_target(
                cur, ids["org_a"], ids["alice"], auto_discover=True,
            )
            conn.commit()

        with listener.cursor() as lc:
            lc.execute("LISTEN target_discovery_requested")

        with conn.cursor() as cur:
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            cur.execute(
                "UPDATE public.targets SET auto_discover = false WHERE id = %s",
                (target_id,),
            )
            conn.commit()

            received = []
            for n in listener.notifies(timeout=0.5):
                received.append(n.payload)
            assert received == []
    finally:
        listener.close()


def test_target_update_unrelated_field_does_not_fire_discovery(conn):
    """Editing a target's name (or any non-auto_discover field) should
    not re-trigger discovery — the trigger is keyed on auto_discover."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            target_id = _seed_domain_target(
                cur, ids["org_a"], ids["alice"], auto_discover=True,
            )
            conn.commit()

        with listener.cursor() as lc:
            lc.execute("LISTEN target_discovery_requested")

        with conn.cursor() as cur:
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            cur.execute(
                "UPDATE public.targets SET description = 'edited' WHERE id = %s",
                (target_id,),
            )
            conn.commit()

            received = []
            for n in listener.notifies(timeout=0.5):
                received.append(n.payload)
            assert received == []
    finally:
        listener.close()


def test_target_insert_does_not_fire_discovery_for_non_domain(conn):
    """The notify trigger only fires on type='domain', regardless of
    auto_discover."""
    if psycopg is None:
        pytest.skip("psycopg not installed")

    listener = psycopg.connect(DB_URL, autocommit=True, connect_timeout=2)
    try:
        with listener.cursor() as lc:
            lc.execute("LISTEN target_discovery_requested")

        with conn.cursor() as cur:
            ids = _seed_two_orgs(cur)
            _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
            cur.execute(
                "INSERT INTO public.targets "
                "(org_id, name, type, value, created_by, auto_discover) "
                "VALUES (%s, %s, 'repository', %s, %s, true) RETURNING id",
                (ids["org_a"], "acme/api", "https://github.com/acme/api", ids["alice"]),
            )
            conn.commit()

            received = []
            for n in listener.notifies(timeout=0.5):
                received.append(n.payload)
            assert received == []
    finally:
        listener.close()


def test_promote_discovery_creates_new_target_and_links(conn):
    """User accepts a discovery → a new target row exists, and the
    discovery row is marked accepted with promoted_target_id set."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        parent_id = _seed_domain_target(cur, ids["org_a"], ids["alice"])

        # Worker would normally insert discoveries; do it as service_role
        # to mimic that path.
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute(
            "INSERT INTO public.target_discoveries (target_id, org_id, source, value) "
            "VALUES (%s, %s, 'crt_sh', 'api.acme.com') RETURNING id",
            (parent_id, ids["org_a"]),
        )
        disc_id = str(cur.fetchone()[0])

        # Switch back to the user and call the promote RPC.
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        cur.execute("SELECT public.promote_discovery_to_target(%s)", (disc_id,))
        new_target_id = str(cur.fetchone()[0])

        # The new target exists with the right type/value/parent org.
        cur.execute(
            "SELECT type, value, org_id FROM public.targets WHERE id = %s",
            (new_target_id,),
        )
        target_type, target_value, target_org = cur.fetchone()
        assert target_type == "domain"
        assert target_value == "api.acme.com"
        assert str(target_org) == ids["org_a"]

        # The discovery row is now linked.
        cur.execute(
            "SELECT status, promoted_target_id FROM public.target_discoveries "
            "WHERE id = %s",
            (disc_id,),
        )
        status, promoted_id = cur.fetchone()
        assert status == "accepted"
        assert str(promoted_id) == new_target_id


def test_promote_discovery_is_idempotent(conn):
    """Pressing Accept twice should not create two targets — return the
    same one."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        parent_id = _seed_domain_target(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute(
            "INSERT INTO public.target_discoveries (target_id, org_id, source, value) "
            "VALUES (%s, %s, 'crt_sh', 'api.acme.com') RETURNING id",
            (parent_id, ids["org_a"]),
        )
        disc_id = str(cur.fetchone()[0])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        cur.execute("SELECT public.promote_discovery_to_target(%s)", (disc_id,))
        first = str(cur.fetchone()[0])

        cur.execute("SELECT public.promote_discovery_to_target(%s)", (disc_id,))
        second = str(cur.fetchone()[0])

        assert first == second

        # Only one target row created.
        cur.execute(
            "SELECT count(*) FROM public.targets WHERE value = 'api.acme.com'"
        )
        assert cur.fetchone()[0] == 1


def test_dismiss_via_rls_update_works_for_org_member(conn):
    """Org member can mark a discovery dismissed — direct UPDATE through RLS,
    no RPC needed."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        parent_id = _seed_domain_target(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute(
            "INSERT INTO public.target_discoveries (target_id, org_id, source, value) "
            "VALUES (%s, %s, 'crt_sh', 'api.acme.com') RETURNING id",
            (parent_id, ids["org_a"]),
        )
        disc_id = str(cur.fetchone()[0])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        cur.execute(
            "UPDATE public.target_discoveries SET status='dismissed' WHERE id = %s",
            (disc_id,),
        )

        cur.execute(
            "SELECT status FROM public.target_discoveries WHERE id = %s", (disc_id,)
        )
        assert cur.fetchone()[0] == "dismissed"


def test_rls_blocks_cross_org_read_of_discoveries(conn):
    """Bob cannot see Alice's discoveries — RLS scopes by org."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"])
        parent_id = _seed_domain_target(cur, ids["org_a"], ids["alice"])

        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="service_role")
        cur.execute(
            "INSERT INTO public.target_discoveries (target_id, org_id, source, value) "
            "VALUES (%s, %s, 'crt_sh', 'api.acme.com') RETURNING id",
            (parent_id, ids["org_a"]),
        )

        # Bob switches in.
        _set_jwt(cur, sub=ids["bob"], org_id=ids["org_b"])
        cur.execute(
            "SELECT count(*) FROM public.target_discoveries WHERE target_id = %s",
            (parent_id,),
        )
        assert cur.fetchone()[0] == 0

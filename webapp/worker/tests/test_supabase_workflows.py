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
    """Create alice in org_a (owner) and bob in org_b (owner). Returns their IDs."""
    alice = uuid.uuid4()
    bob = uuid.uuid4()
    org_a = uuid.uuid4()
    org_b = uuid.uuid4()

    cur.execute(
        "INSERT INTO auth.users (id, email) VALUES (%s, %s), (%s, %s)",
        (alice, "alice@a.test", bob, "bob@b.test"),
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
    """vault_create_secret raises if called outside the service role."""
    with conn.cursor() as cur:
        ids = _seed_two_orgs(cur)
        _set_jwt(cur, sub=ids["alice"], org_id=ids["org_a"], jwt_role="authenticated")

        with pytest.raises(psycopg.errors.RaiseException):
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

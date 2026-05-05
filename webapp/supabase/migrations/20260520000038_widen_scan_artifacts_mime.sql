-- Bug fix surfaced by Tier 0 / Tier A e2e domain test (run #5).
--
-- The scan-artifacts bucket's allowed_mime_types was set to a narrow
-- {text/markdown, application/json, text/plain, application/octet-stream}
-- in the original storage-bucket creation. Several Tier 4 PRs added new
-- artifact types that don't fit:
--
--   - findings.csv          (text/csv)             — engine PR #129 compliance pack
--   - events.jsonl          (application/x-ndjson) — engine PR #137
--   - trajectory.jsonl      (application/x-ndjson) — engine PR #142
--   - sbom.cdx.json         (application/vnd.cyclonedx+json) — engine PR #131
--   - signature.txt         (text/plain)           — already covered
--
-- The compliance-pack upload from the e2e run silently dropped
-- findings.csv with a 415 invalid_mime_type error from Supabase
-- storage. Auditors then download a zip missing the CSV — the most
-- compliance-team-friendly artifact.
--
-- Widening the allowlist to cover every shape the engine emits +
-- the wrapper hand-types in `_PACK_CONTENT_TYPES`. Defence in depth:
-- the worker still asserts content-type per file (so a malicious
-- override can't sneak in an HTML page disguised as a SBOM).

update storage.buckets
   set allowed_mime_types = array[
     -- Originals (preserved for back-compat with existing artifacts).
     'text/markdown',
     'application/json',
     'text/plain',
     'application/octet-stream',
     -- Compliance-pack additions (engine PR #129).
     'text/csv',
     'application/x-ndjson',           -- events.jsonl, trajectory.jsonl
     'application/vnd.cyclonedx+json', -- sbom.cdx.json (CycloneDX 1.5)
     -- Edge cases the engine emits with explicit charset suffixes.
     'text/plain; charset=utf-8'
   ]
 where id = 'scan-artifacts';

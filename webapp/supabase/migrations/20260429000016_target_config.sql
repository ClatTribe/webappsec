-- Foundational plumbing for per-target-type configuration (roadmap §9.1).
--
-- Today every option a user has in their head about how to scan a target
-- has to be jammed into `instruction_text` (the free-form scan brief). This
-- migration adds a typed `targets.config jsonb` slot, validated at the API
-- boundary by a discriminated zod schema and read by the worker's
-- `_build_instruction` augmenter to produce well-formed Strix prompts.
--
-- We don't enforce the shape at the database layer — jsonb only guarantees
-- valid JSON — because:
--   1. The only writers are the API (zod-validated) and the worker (writes
--      empty `'{}'` via promote_discovery_to_target). A direct SQL writer
--      bypassing both is a debugging path, not a runtime path.
--   2. A plpgsql validator per target.type adds significant complexity for
--      defence in depth that's already covered by RLS + zod.
--
-- The shape contract lives in the frontend zod schema and is mirrored in
-- the worker's instruction augmenter. Document drift = bug, treat it as one.

alter table public.targets
  add column if not exists config jsonb not null default '{}'::jsonb;

-- Existing rows get the empty default; nothing to backfill.

-- We may eventually want indexes on config keys (e.g. find every target
-- with rate_limit_qps set), but no current query path needs them.

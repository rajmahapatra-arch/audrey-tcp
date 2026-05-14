# Migrations

SQL migrations applied to the shared Supabase instance.

## Convention

- Filename: `NNN_short_description.sql` (e.g. `001_audit_log_table.sql`)
- Numbered sequentially, never re-used
- Idempotent where possible (`CREATE TABLE IF NOT EXISTS`, etc.)
- Forward-only — never modify a committed migration; write a new one
- Each migration has a top comment explaining what it does and why

## Schema lineage

The shared Supabase instance currently hosts the **existing Audrey
schema** (matter_memory, clients, matters, documents, document_chunks,
etc.). Audrey TCP migrations:

1. **Add new tables alongside** the existing schema (`positions`,
   `position_history`, `events`, `counterparty_observations`,
   `audit_log`)
2. **Add new columns** to existing tables where needed
   (e.g. `matters.stage`, `matters.privilege_scope`)
3. **Do not modify** existing Audrey-core data until Stage B's
   migration phase, which transforms `matter_memory` into the new
   `events` schema

## Stage A migrations (planned)

- `001_audit_log_table.sql` — append-only audit log table (REQUIRED
  for compliance posture, must ship with first commit)
- `002_matter_columns.sql` — add `stage` and `privilege_scope` to
  `matters` table
- `003_positions_table.sql` — open/settled positions
- `004_position_history_table.sql` — append-only history
- `005_events_table.sql` — append-only matter event log
- `006_counterparty_observations_table.sql` — cross-matter
  counterparty intelligence
- `007_rls_policies.sql` — RLS on all new tables, scoped by `firm_id`
- `008_rls_test_fixtures.sql` — fixtures for the CI test suite that
  asserts firm-isolation

Migrations applied by the developer; no auto-run in production until
Stage B (when we have multiple environments to keep in sync).

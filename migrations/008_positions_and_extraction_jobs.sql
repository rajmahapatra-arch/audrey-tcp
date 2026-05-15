-- 008_positions_and_extraction_jobs.sql
--
-- Stage B: structured storage for clause-level positions + a jobs
-- table to track the async extraction pipeline.
--
-- positions:
--   - One row per (matter, clause_type, party_role) snapshot
--   - Populated by the LLM extraction pass on document intake
--   - Queries against this power get_open_positions,
--     get_settled_positions, and get_counterparty_history
--   - Older versions marked superseded_by when re-extraction occurs
--
-- extraction_jobs:
--   - One row per extraction attempt
--   - Status: pending → running → completed | failed
--   - Lets the tool layer report "extraction pending" cleanly when a
--     newly uploaded document hasn't been processed yet
--
-- Forward-only, idempotent (IF NOT EXISTS guards).

-- ============================================================
-- 1. positions
-- ============================================================

CREATE TABLE IF NOT EXISTS positions (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid         NOT NULL,
  matter_id           uuid         NOT NULL REFERENCES matters(id),

  -- WHAT (clause + value)
  clause_type         text         NOT NULL,   -- 'liability_cap', 'ip_indemnity', 'governing_law', etc.
  value               jsonb        NOT NULL,   -- {amount: '12 months fees'} or {scope: 'unlimited'} etc.
  status              text         NOT NULL
                                   CHECK (status IN ('proposed','open','settled','rejected'))
                                   DEFAULT 'open',

  -- WHO (party context — nullable for symmetric clauses like governing_law)
  counterparty_name   text,                    -- denormalised for fast filter; structured ref later
  party_role          text         CHECK (party_role IN ('our_side','counterparty','neutral','mutual')),

  -- PROVENANCE
  source_document_id  uuid         REFERENCES documents(id),
  source_chunk_text   text,                    -- the raw excerpt this came from (for auditability)
  extracted_at        timestamptz  NOT NULL DEFAULT now(),
  extracted_by        text         NOT NULL,   -- e.g. 'claude-sonnet-4-7@2026-04'
  confidence          numeric      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  raw_extract         jsonb,                   -- verbatim model output for debugging / re-parsing

  -- LIFECYCLE
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  superseded_by       uuid         REFERENCES positions(id)
);

-- Most common access patterns
CREATE INDEX IF NOT EXISTS positions_firm_matter_idx
  ON positions (firm_id, matter_id) WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS positions_counterparty_idx
  ON positions (counterparty_name, clause_type)
  WHERE counterparty_name IS NOT NULL AND superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS positions_active_status_idx
  ON positions (matter_id, status) WHERE superseded_by IS NULL;

-- RLS — firm isolation for reads
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY positions_firm_isolation ON positions
  FOR SELECT
  USING (firm_id = current_setting('audrey.firm_id', true)::uuid);

COMMENT ON TABLE positions IS
  'Stage B: clause-level positions extracted from matter documents. Each row is one '
  'party''s position on one clause for one matter, with provenance back to the source '
  'document and excerpt. Re-extraction supersedes older rows (older.superseded_by = '
  'newer.id) so the full history is preserved.';

-- ============================================================
-- 2. extraction_jobs
-- ============================================================

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid         NOT NULL,
  document_id         uuid         NOT NULL REFERENCES documents(id),
  matter_id           uuid,                    -- may be set even if doc is a precedent

  -- Status machine: pending → running → completed | failed | cancelled
  status              text         NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','running','completed','failed','cancelled')),

  -- Timing
  queued_at           timestamptz  NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,

  -- Results
  positions_extracted integer,
  chunks_embedded     integer,
  embedding_model     text,
  extraction_model    text,
  error_message       text,

  -- What triggered this job
  triggered_by        text         NOT NULL
                                   CHECK (triggered_by IN
                                          ('document_upload','manual_reextract','tool_call','scheduled_backfill')),
  triggered_by_user   uuid                     -- nullable: scheduled jobs have no user
);

CREATE INDEX IF NOT EXISTS extraction_jobs_pending_idx
  ON extraction_jobs (queued_at)
  WHERE status IN ('pending','running');

CREATE INDEX IF NOT EXISTS extraction_jobs_document_idx
  ON extraction_jobs (document_id, queued_at DESC);

ALTER TABLE extraction_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY extraction_jobs_firm_isolation ON extraction_jobs
  FOR SELECT
  USING (firm_id = current_setting('audrey.firm_id', true)::uuid);

COMMENT ON TABLE extraction_jobs IS
  'Stage B: one row per extraction attempt against a document. Tools can use this to '
  'report "extraction pending" when a newly ingested document does not yet have positions '
  'available. Failed jobs retain the error_message for triage.';

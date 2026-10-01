-- 014_matter_decisions_and_working_record.sql
--
-- Matter Memory Stage 1 (spec: docs/matter-memory-spec.md; schema
-- signed off in docs/matter-memory-schema-proposal.md, PR #42).
--
--   1. matter_decisions — authoritative decision records with reasons,
--      provenance, the explicit-user-act settle gate, and THE single
--      supersession chain.
--   2. audrey_settle_decision() — the one atomic writer of chain
--      state, coupling a linked position's superseded_by in the same
--      transaction.
--   3. matter_memory working-record columns (AUD-602).
--
-- RLS posture (lesson of fix #46): RLS is ENABLED with NO anon
-- policies — deny-all for anon; the service client (which bypasses
-- RLS) is the only production reader/writer, with firm scoping
-- enforced explicitly in the repository layer. No session-GUC
-- pretense that production never satisfies.
--
-- Forward-only, idempotent (IF NOT EXISTS guards).

-- ============================================================
-- 1. matter_decisions
-- ============================================================

CREATE TABLE IF NOT EXISTS matter_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL,
  matter_id             uuid NOT NULL REFERENCES matters(id),
  user_id               uuid,

  decision              text NOT NULL,
  reasons               text[] NOT NULL DEFAULT '{}',
  alternatives_rejected jsonb NOT NULL DEFAULT '[]',
  reopen_conditions     text,

  position_id           uuid REFERENCES positions(id),
  source_document_id    uuid REFERENCES documents(id),

  status                text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','settled','superseded','dismissed')),

  -- provenance: stamped SERVER-SIDE from the authenticated client
  source_tool           text NOT NULL,
  source_session_id     text,
  proposed_at           timestamptz NOT NULL DEFAULT now(),

  -- the explicit user act (spec §2: model inference never settles)
  settled_via           text,
  settled_at            timestamptz,
  confirmation_text     text,

  supersedes_id         uuid REFERENCES matter_decisions(id),
  superseded_by_id      uuid REFERENCES matter_decisions(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- AUD-632 enforced by Postgres, not just the server
  CONSTRAINT settled_needs_act CHECK (
    status NOT IN ('settled','superseded')
    OR (settled_via IS NOT NULL AND settled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS matter_decisions_active_idx
  ON matter_decisions (firm_id, matter_id)
  WHERE status IN ('proposed','settled');

CREATE INDEX IF NOT EXISTS matter_decisions_position_idx
  ON matter_decisions (position_id) WHERE position_id IS NOT NULL;

ALTER TABLE matter_decisions ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all except service_role (bypasses
-- RLS). See header note.

COMMENT ON TABLE matter_decisions IS
  'Authoritative matter decisions with reasons, alternatives and reopen conditions. '
  'Settling requires an explicit user act (settled_via + settled_at enforced by CHECK). '
  'Supersession chain lives HERE; linked positions'' superseded_by is a projection '
  'maintained atomically by audrey_settle_decision(). Superseded rows retained forever.';

-- ============================================================
-- 2. The single atomic writer of chain state
-- ============================================================

CREATE OR REPLACE FUNCTION audrey_settle_decision(
  p_decision_id       uuid,
  p_settled_via       text,
  p_confirmation_text text DEFAULT NULL,
  p_supersedes_id     uuid DEFAULT NULL
) RETURNS matter_decisions
LANGUAGE plpgsql
AS $$
DECLARE
  v_new matter_decisions;
  v_old matter_decisions;
BEGIN
  SELECT * INTO v_new FROM matter_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decision % not found', p_decision_id;
  END IF;
  IF v_new.status <> 'proposed' THEN
    RAISE EXCEPTION 'decision % is %, only proposed decisions can be settled',
      p_decision_id, v_new.status;
  END IF;

  IF p_supersedes_id IS NOT NULL THEN
    SELECT * INTO v_old FROM matter_decisions WHERE id = p_supersedes_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'superseded decision % not found', p_supersedes_id;
    END IF;
    IF v_old.status <> 'settled' THEN
      RAISE EXCEPTION 'decision % is %, only settled decisions can be superseded',
        p_supersedes_id, v_old.status;
    END IF;
    IF v_old.matter_id <> v_new.matter_id THEN
      RAISE EXCEPTION 'supersession must stay within one matter';
    END IF;

    UPDATE matter_decisions
      SET status = 'superseded', superseded_by_id = p_decision_id,
          updated_at = now()
      WHERE id = p_supersedes_id;

    -- One chain: project onto linked positions when both ends are
    -- clause-shaped and distinct.
    IF v_old.position_id IS NOT NULL
       AND v_new.position_id IS NOT NULL
       AND v_old.position_id <> v_new.position_id THEN
      UPDATE positions SET superseded_by = v_new.position_id, updated_at = now()
        WHERE id = v_old.position_id AND superseded_by IS NULL;
    END IF;
  END IF;

  UPDATE matter_decisions
    SET status = 'settled',
        settled_via = p_settled_via,
        settled_at = now(),
        confirmation_text = p_confirmation_text,
        supersedes_id = COALESCE(p_supersedes_id, supersedes_id),
        updated_at = now()
    WHERE id = p_decision_id
    RETURNING * INTO v_new;

  RETURN v_new;
END;
$$;

-- ============================================================
-- 3. matter_memory working-record columns (AUD-602)
-- ============================================================
-- status vocabulary additionally gains 'captured' (auto-capture,
-- invisible to the endorsed/pending curation view until surfaced) —
-- no CHECK constraint exists on status; app-enforced as today.

ALTER TABLE matter_memory
  ADD COLUMN IF NOT EXISTS kind text
    CHECK (kind IS NULL OR kind IN ('note','reasoning','context','open_question')),
  ADD COLUMN IF NOT EXISTS source_tool text,
  ADD COLUMN IF NOT EXISTS source_session_id text,
  ADD COLUMN IF NOT EXISTS promoted_to uuid REFERENCES matter_decisions(id),
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

CREATE INDEX IF NOT EXISTS matter_memory_captured_idx
  ON matter_memory (matter_id, created_at DESC)
  WHERE status = 'captured';

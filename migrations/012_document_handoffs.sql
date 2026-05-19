-- 012_document_handoffs.sql
--
-- Per-document conversational memory bridging the gap that Claude for
-- Word doesn't retain context between sessions on the same document.
--
-- Flow:
--   - At conversation start (document in scope), Claude calls
--     audrey_document_handoff(action="get") with the doc's title and
--     size signals. If a match is found, Claude surfaces a brief recap
--     so the user knows Audrey "remembers" the doc.
--   - At conversation end or every N turns, Claude calls the same tool
--     with action="update" to persist a fresh summary.
--
-- Matching strategy (v1):
--   - Loose tuple: (firm_id, doc_title_normalised) + tolerance bands on
--     paragraph_count and word_count.
--   - Normalisation: lowercase, strip whitespace, strip version
--     suffixes like " (2)", "_v3", "_final" — handled application-side
--     so the SQL stays simple. The normalised string is what's
--     persisted and indexed.
--   - The MCP handler resolves the best match by smallest delta on
--     paragraph_count + word_count. Two near-identical drafts of the
--     same doc may both surface; Claude disambiguates with the user.
--
-- Forward-only, idempotent (IF NOT EXISTS guards).

-- ============================================================
-- 1. document_handoffs
-- ============================================================

CREATE TABLE IF NOT EXISTS document_handoffs (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 uuid         NOT NULL,

  -- Identification
  doc_title               text         NOT NULL,    -- raw filename, preserved for display
  doc_title_normalised    text         NOT NULL,    -- lowercase/strip-suffix; the match key
  paragraph_count         integer      NOT NULL CHECK (paragraph_count >= 0),
  word_count              integer      NOT NULL CHECK (word_count >= 0),

  -- The handoff itself
  summary                 text         NOT NULL,
  turn_count              integer      NOT NULL DEFAULT 0 CHECK (turn_count >= 0),

  -- Provenance
  last_active             timestamptz  NOT NULL DEFAULT now(),
  last_active_user_id     uuid,                     -- who was working when we last saved
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now()
);

-- Lookup is always firm-scoped + normalised-title-keyed.
CREATE INDEX IF NOT EXISTS document_handoffs_firm_title_idx
  ON document_handoffs (firm_id, doc_title_normalised);

-- Secondary: surface "most recent across the firm" for catch-up dashboards later.
CREATE INDEX IF NOT EXISTS document_handoffs_firm_recency_idx
  ON document_handoffs (firm_id, last_active DESC);

-- ============================================================
-- 2. RLS — firm isolation, same pattern as positions/extraction_jobs
-- ============================================================

ALTER TABLE document_handoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_handoffs_firm_isolation ON document_handoffs;
CREATE POLICY document_handoffs_firm_isolation ON document_handoffs
  FOR ALL
  USING (firm_id = current_setting('audrey.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('audrey.firm_id', true)::uuid);

-- ============================================================
-- 3. updated_at trigger
-- ============================================================
--
-- Standard "stamp updated_at on UPDATE" pattern. Matches existing
-- conventions (see firm_users.min_token_iat migration 011).

CREATE OR REPLACE FUNCTION document_handoffs_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_handoffs_updated_at_trg ON document_handoffs;
CREATE TRIGGER document_handoffs_updated_at_trg
  BEFORE UPDATE ON document_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION document_handoffs_set_updated_at();

-- ============================================================
-- 4. Comments
-- ============================================================

COMMENT ON TABLE document_handoffs IS
  'Per-document conversational memory for Audrey. Bridges Claude for Word''s '
  'lack of cross-session context on the same document. Matched on a loose '
  'tuple (firm_id, normalised filename, ~paragraph_count, ~word_count) so '
  'small edits don''t break recovery.';

COMMENT ON COLUMN document_handoffs.doc_title_normalised IS
  'Application-normalised title used for matching: lowercase, whitespace '
  'collapsed, version suffixes stripped (e.g. " (2)", "_v3", "_final"). '
  'See mcp-server/src/tools/documentHandoff.ts for normalise().';

COMMENT ON COLUMN document_handoffs.summary IS
  '2-5 sentence recap covering: what was discussed, what was decided, '
  'what''s pending, any user-flagged remembers. Re-emitted on each update.';

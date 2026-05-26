-- 013_documents_word_doc_id_nullable.sql
--
-- Drop the NOT NULL constraint on documents.word_doc_id.
--
-- Background:
--   The documents table was originally created by the legacy Word
--   taskpane's schema. In that world, every document had a stable
--   Office identifier (Word.context.document.url) which was used as
--   the row key. The column was therefore declared NOT NULL.
--
--   Audrey TCP adds new ingestion paths that don't have a Word doc
--   URL at insert time:
--     - upload_document MCP tool (called from Claude.ai, Claude
--       Desktop, or any non-Office surface)
--     - config-ui drag-and-drop upload (planned)
--     - Stage B job runner re-ingestion of historical docs
--   None of these can populate word_doc_id, but they're legitimate
--   document sources.
--
--   Surfaced 2026-05-25 by a failed upload_document call from Claude
--   for Word: the tool inserts without word_doc_id, hits the NOT NULL
--   constraint, errors. The fix is structural — the column should be
--   nullable, populated when (and only when) the ingestion path
--   actually has an Office identifier.
--
-- The change is data-safe:
--   - Existing rows already have non-null word_doc_id (the constraint
--     prevented them from being inserted otherwise) — nothing changes
--     for them.
--   - No UNIQUE constraint on word_doc_id today, so multiple NULL rows
--     are fine even in older PostgreSQL versions.
--
-- Forward-only, idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'documents'
      AND column_name = 'word_doc_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.documents
      ALTER COLUMN word_doc_id DROP NOT NULL;
    RAISE NOTICE 'Dropped NOT NULL on documents.word_doc_id';
  ELSE
    RAISE NOTICE 'documents.word_doc_id is already nullable or column absent — no change';
  END IF;
END $$;

COMMENT ON COLUMN public.documents.word_doc_id IS
  'Office stable document identifier (Word.context.document.url). '
  'Populated when ingestion came from a Word add-in surface; NULL when '
  'the document came from chat upload (upload_document MCP tool), '
  'config-ui drag-and-drop, or any other source that does not provide '
  'an Office identifier.';

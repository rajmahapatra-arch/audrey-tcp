-- 017_document_ingestion.sql
--
-- Document ingestion I1 (spec: docs/document-ingestion-spec.md, PR #60).
--
--   1. Private Storage bucket `documents` for ORIGINAL files.
--   2. `documents` becomes the single document store: original-file
--      columns, Markdown working text, conversion provenance, and the
--      fields the Context Capture library (matter_documents) carries,
--      so step I5 can fold the library in.
--
-- RLS posture (as 014): no anon/authenticated policies on the bucket's
-- objects — deny-all; the backend's service client (bypasses RLS) is
-- the only reader/writer, and downloads go out as short-lived signed
-- URLs issued after a firm check.
--
-- Forward-only, idempotent. Does NOT move any data — the library
-- migration is I5.

-- ============================================================
-- 1. Storage bucket for originals
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  26214400,  -- 25 MB
  ARRAY[
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf',
    'text/plain',
    'text/markdown'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. documents: single store
-- ============================================================

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS client_id           uuid REFERENCES clients(id),
  -- the original file
  ADD COLUMN IF NOT EXISTS storage_path        text,
  ADD COLUMN IF NOT EXISTS file_sha256         text,
  ADD COLUMN IF NOT EXISTS mime_type           text,
  ADD COLUMN IF NOT EXISTS file_size           integer,
  ADD COLUMN IF NOT EXISTS page_count          integer,
  -- the working text (source of truth once converted; `content` is kept
  -- in sync during the transition for existing readers)
  ADD COLUMN IF NOT EXISTS markdown            text,
  ADD COLUMN IF NOT EXISTS conversion_method   text,   -- docx-native | pdf-text | pdf-claude | pdf-mixed | text | legacy-text
  ADD COLUMN IF NOT EXISTS conversion_version  integer,
  ADD COLUMN IF NOT EXISTS conversion_warnings jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS tracked_changes     jsonb,  -- ins/del/comments found in a .docx (accepted view is in markdown)
  ADD COLUMN IF NOT EXISTS ingest_status       text,   -- stored | converted | failed (NULL = pre-pipeline row)
  ADD COLUMN IF NOT EXISTS ingest_error        text,
  -- carried over from the library (matter_documents)
  ADD COLUMN IF NOT EXISTS document_role       text,
  ADD COLUMN IF NOT EXISTS user_context        text,
  ADD COLUMN IF NOT EXISTS legacy_library_id   uuid;   -- set on rows folded in from matter_documents (I5)

-- A document belongs to a matter OR is client-wide — never both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_matter_xor_client') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_matter_xor_client
      CHECK (matter_id IS NULL OR client_id IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_ingest_status_check') THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_ingest_status_check
      CHECK (ingest_status IS NULL OR ingest_status IN ('stored','converted','failed'));
  END IF;
END $$;

-- The same file uploaded twice to the same matter (or client) is one document.
CREATE UNIQUE INDEX IF NOT EXISTS documents_file_dedupe_idx
  ON documents (firm_id, COALESCE(matter_id, client_id), file_sha256)
  WHERE file_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_client_idx
  ON documents (client_id) WHERE client_id IS NOT NULL;

COMMENT ON COLUMN documents.markdown IS
  'Working text, converted once at upload. Everything downstream (passages, extraction, chat, comparison) reads this, never the file.';
COMMENT ON COLUMN documents.storage_path IS
  'Path of the unchanged original in the private `documents` bucket: {firm_id}/{matter_id | client:{client_id}}/{sha256}.{ext}';

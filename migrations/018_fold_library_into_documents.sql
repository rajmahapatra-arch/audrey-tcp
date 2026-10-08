-- 018_fold_library_into_documents.sql
--
-- Document ingestion I5 (spec: docs/document-ingestion-spec.md §3.5, §4).
-- REQUIRES 017. Raj runs it; forward-only, idempotent (safe to re-run —
-- and it SHOULD be re-run once after the legacy backend deploy, to pick up
-- any library upload made through the old code in between).
--
--   1. Copy every Context Capture library row (matter_documents) into the
--      single store `documents`: matter or client scope, role, note, page
--      count, size; the extracted text becomes `markdown` (and `content`,
--      kept in sync during the transition) with conversion_method
--      'legacy-text'. The originals were never kept and cannot be recovered.
--   2. Existing `documents` rows (pane uploads, "add current document",
--      upload_document) get markdown = content, 'legacy-text'.
--   3. Queue an extraction job ('scheduled_backfill') for every copied row,
--      so the TCP job runner chunks them into the single passage index
--      (matter_memory, memory_type='chunk') within minutes.
--   4. match_document_passages(): the chat's passage search over that index
--      (firm + matter, plus the client-wide documents of the matter's client).
--   5. matter_documents / matter_document_chunks / document_embeddings are
--      left in place, FROZEN (nothing writes or reads them after the I4/I5
--      deploy); retire them once parity is confirmed.
--
-- Column names verified against the LIVE schema (PostgREST OpenAPI,
-- 2026-10-08) and 017:
--   matter_documents: id, matter_id, client_id, filename, file_size,
--     page_count, document_role, user_context, status, error_message,
--     original_content, uploaded_at, uploaded_by (TEXT — not mapped to
--     documents.user_id, which is uuid), chunk_count, total_tokens
--   matters.firm_id uuid, clients.firm_id uuid (both exist; no NULLs live)
--   documents.firm_id uuid (nullable live — always stamped here)
--   extraction_jobs: firm_id NOT NULL, document_id NOT NULL,
--     triggered_by NOT NULL CHECK IN ('document_upload','manual_reextract',
--     'tool_call','scheduled_backfill'), status default 'pending'
--   matter_memory: content text, memory_type varchar, source_document_id
--     varchar (holds documents.id as text), embedding vector(1536),
--     embedding_model text, firm_id uuid, scope text
--
-- Legacy documents list for Raj (spec §4; re-uploading one gains the
-- original and proper Markdown):
--   SELECT d.id, d.name, d.matter_id, d.client_id, d.document_role
--     FROM documents d WHERE d.conversion_method = 'legacy-text'
--     ORDER BY d.added_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'legacy_library_id'
  ) THEN
    RAISE EXCEPTION '018 requires migration 017 (documents.legacy_library_id is missing)';
  END IF;
END $$;

-- ============================================================
-- 1. matter_documents -> documents
-- ============================================================

INSERT INTO documents (
  name, matter_id, client_id, firm_id,
  word_doc_id, doc_type, status, notes,
  markdown, content, content_snapshot,
  conversion_method, conversion_version, conversion_warnings,
  ingest_status, ingest_error,
  document_role, user_context, page_count, file_size,
  legacy_library_id, added_at, last_modified
)
SELECT
  md.filename,
  md.matter_id,
  -- a row has a matter OR a client (017 documents_matter_xor_client)
  CASE WHEN md.matter_id IS NULL THEN md.client_id END,
  COALESCE(m.firm_id, c.firm_id, mc.firm_id, '715b66f5-f7fb-4abe-b4f6-f5676c0117cd'::uuid),
  'uploaded-' || md.id::text,          -- pane compatibility (uploaded docs carry a synthetic id)
  'other',
  'draft',
  'Folded in from the Context Capture library (migration 018)',
  md.original_content,
  md.original_content,
  CASE WHEN md.original_content IS NOT NULL THEN COALESCE(md.uploaded_at, now()) END,
  'legacy-text',
  1,
  '[]'::jsonb,
  -- No text at all = nothing to search; flag it so the library shows
  -- "Failed" with a re-upload hint instead of a silently empty document.
  CASE WHEN md.original_content IS NULL OR btrim(md.original_content) = '' THEN 'failed' ELSE 'converted' END,
  CASE WHEN md.original_content IS NULL OR btrim(md.original_content) = ''
       THEN COALESCE(md.error_message, 'No text was kept for this file; please re-upload it') END,
  md.document_role,
  md.user_context,
  md.page_count,
  md.file_size,
  md.id,
  COALESCE(md.uploaded_at, now()),
  COALESCE(md.uploaded_at, now())
FROM matter_documents md
LEFT JOIN matters m  ON m.id = md.matter_id
LEFT JOIN clients c  ON c.id = md.client_id
LEFT JOIN clients mc ON mc.id = m.client_id
WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.legacy_library_id = md.id);

-- ============================================================
-- 2. Existing documents: the text becomes the working Markdown
-- ============================================================

UPDATE documents
   SET markdown = content,
       conversion_method = COALESCE(conversion_method, 'legacy-text')
 WHERE markdown IS NULL
   AND content IS NOT NULL;

-- ============================================================
-- 3. Re-index the copied library rows into matter_memory
-- ============================================================

INSERT INTO extraction_jobs (firm_id, document_id, matter_id, status, triggered_by)
SELECT d.firm_id, d.id, d.matter_id, 'pending', 'scheduled_backfill'
  FROM documents d
 WHERE d.legacy_library_id IS NOT NULL
   AND d.ingest_status = 'converted'
   AND d.firm_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM extraction_jobs j WHERE j.document_id = d.id);

-- ============================================================
-- 4. Passage search for the chat (single index)
-- ============================================================
--
-- Chunks of the matter's own documents plus the client-wide documents of
-- the matter's client, firm-scoped twice (chunk and document). Only rows
-- embedded with p_embedding_model are compared (similarities across
-- embedding models are meaningless; the AUD-606 sweep converges legacy
-- 3-large rows to 3-small). Returns cosine SIMILARITY (1 - distance).

DROP FUNCTION IF EXISTS match_document_passages(uuid, uuid, vector, int, text);

CREATE OR REPLACE FUNCTION match_document_passages(
  p_firm_id          uuid,
  p_matter_id        uuid,
  p_query_embedding  vector(1536),
  p_match_count      int  DEFAULT 25,
  p_embedding_model  text DEFAULT 'text-embedding-3-small'
)
RETURNS TABLE (
  id             uuid,
  content        text,
  document_id    uuid,
  document_name  text,
  document_role  text,
  user_context   text,
  scope          text,
  is_library     boolean,
  similarity     float
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT mt.client_id
      FROM matters mt
     WHERE mt.id = p_matter_id
       AND mt.firm_id = p_firm_id
  )
  SELECT
    mm.id,
    mm.content,
    d.id,
    d.name,
    d.document_role,
    d.user_context,
    CASE WHEN d.client_id IS NOT NULL THEN 'client' ELSE 'matter' END,
    (d.document_role IS NOT NULL OR d.legacy_library_id IS NOT NULL OR d.client_id IS NOT NULL),
    (1 - (mm.embedding <=> p_query_embedding))::float
  FROM matter_memory mm
  JOIN documents d ON d.id::text = mm.source_document_id
  WHERE mm.firm_id = p_firm_id
    AND mm.memory_type = 'chunk'
    AND mm.embedding IS NOT NULL
    AND (p_embedding_model IS NULL OR mm.embedding_model = p_embedding_model)
    AND d.firm_id = p_firm_id
    AND (
      d.matter_id = p_matter_id
      OR (d.client_id IS NOT NULL AND d.client_id = (SELECT t.client_id FROM target t))
    )
  ORDER BY mm.embedding <=> p_query_embedding
  LIMIT p_match_count;
$$;

-- Firm id is a parameter, so this must not be callable with the anon key.
-- The legacy backend calls it with the service-role client.
REVOKE ALL ON FUNCTION match_document_passages(uuid, uuid, vector, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_document_passages(uuid, uuid, vector, int, text) FROM anon;
REVOKE ALL ON FUNCTION match_document_passages(uuid, uuid, vector, int, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION match_document_passages(uuid, uuid, vector, int, text) TO service_role;

COMMENT ON FUNCTION match_document_passages IS
  'I5 single passage index: cosine similarity over matter_memory chunks of the '
  'matter''s documents plus its client''s client-wide documents. Firm-scoped. '
  'Used by the legacy pane chat (OTHER DOCUMENTS / DOCUMENT LIBRARY context).';

-- ============================================================
-- 5. Freeze the old library store
-- ============================================================

COMMENT ON TABLE matter_documents IS
  'FROZEN by 018: rows copied into documents (legacy_library_id). Nothing writes or reads this '
  'table after the I4/I5 deploy. Retire once parity is confirmed.';
COMMENT ON TABLE matter_document_chunks IS
  'FROZEN by 018: passages now live in matter_memory (memory_type=chunk). Retire once parity is confirmed.';

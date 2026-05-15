-- 009_match_matter_memory_function.sql
--
-- pgvector cosine-distance search over matter_memory.embedding,
-- scoped by firm and optionally by matter. Called by the
-- matterMemoryRepository.searchByEmbedding() method to power the
-- search_matter_text MCP tool.
--
-- Returns rows ordered by ascending cosine distance (so most-similar
-- first). distance is the raw pgvector cosine distance — smaller is
-- closer; subtract from 1 to get similarity if you want.
--
-- Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION match_matter_memory(
  p_firm_id          uuid,
  p_query_embedding  vector(1536),
  p_match_count      int     DEFAULT 8,
  p_matter_id        uuid    DEFAULT NULL
)
RETURNS TABLE (
  id                 uuid,
  matter_id          uuid,
  content            text,
  memory_type        text,
  source_document_id text,
  embedding_model    text,
  created_at         timestamp with time zone,
  distance           float
)
LANGUAGE plpgsql
SECURITY DEFINER  -- run with the function owner's privileges so anon clients can call it
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mm.id,
    mm.matter_id,
    mm.content,
    mm.memory_type,
    mm.source_document_id,
    mm.embedding_model,
    mm.created_at,
    (mm.embedding <=> p_query_embedding)::float AS distance
  FROM matter_memory mm
  WHERE mm.firm_id = p_firm_id
    AND mm.embedding IS NOT NULL
    AND (p_matter_id IS NULL OR mm.matter_id = p_matter_id)
  ORDER BY mm.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- Allow the anon role (used by tool handlers) to call this function.
-- The function itself enforces firm_id scoping, and SECURITY DEFINER
-- means it can read matter_memory rows that are RLS-blocked from the
-- anon role directly. This is the standard pgvector + Supabase pattern.
GRANT EXECUTE ON FUNCTION match_matter_memory(uuid, vector, int, uuid) TO anon;
GRANT EXECUTE ON FUNCTION match_matter_memory(uuid, vector, int, uuid) TO authenticated;

COMMENT ON FUNCTION match_matter_memory IS
  'Cosine-distance search over matter_memory.embedding, firm-scoped. '
  'Returns top N matches ordered by similarity. Used by search_matter_text MCP tool.';

-- 010_fix_match_matter_memory_types.sql
--
-- Migration 009 declared match_matter_memory()'s RETURNS TABLE with
-- types that don't exactly match the underlying matter_memory columns:
--
--   memory_type           — actual: character varying, declared: text
--   created_at            — actual: timestamp without time zone,
--                           declared: timestamp with time zone
--   source_document_id    — actual: character varying, declared: text
--
-- Postgres is strict about RETURNS TABLE matching the SELECT column
-- types exactly. Mismatches throw at call time:
--   "structure of query does not match function result type"
--
-- Fix: drop and recreate with the actual column types. Subsequent
-- code (matterMemoryRepository.searchByEmbedding) doesn't care about
-- text vs varchar at the JS layer — they serialise the same way.
--
-- Idempotent: DROP IF EXISTS + CREATE OR REPLACE.

DROP FUNCTION IF EXISTS match_matter_memory(uuid, vector, int, uuid);

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
  memory_type        character varying,
  source_document_id character varying,
  embedding_model    text,
  created_at         timestamp without time zone,
  distance           float
)
LANGUAGE plpgsql
SECURITY DEFINER
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

GRANT EXECUTE ON FUNCTION match_matter_memory(uuid, vector, int, uuid) TO anon;
GRANT EXECUTE ON FUNCTION match_matter_memory(uuid, vector, int, uuid) TO authenticated;

COMMENT ON FUNCTION match_matter_memory IS
  'Cosine-distance search over matter_memory.embedding. Firm-scoped. '
  'Returns top N matches ordered by similarity. Used by search_matter_text MCP tool. '
  'v2: RETURNS TABLE types corrected to match underlying matter_memory column types '
  '(character varying instead of text; timestamp without time zone for created_at).';

-- 016_chat_sessions_firm_id.sql
--
-- Stage 2a: the legacy backend now stamps firm_id at write on all
-- shared tables (ending the five-incident unstamped-rows class), but
-- chat_sessions never had the column. Add it and backfill existing
-- rows: from the parent matter where linked, else the single-firm
-- constant (same rule as 015 step 0a).
--
-- Forward-only, idempotent.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS firm_id uuid;

UPDATE chat_sessions cs
SET firm_id = m.firm_id
FROM matters m
WHERE cs.matter_id = m.id AND cs.firm_id IS NULL;

UPDATE chat_sessions
SET firm_id = '715b66f5-f7fb-4abe-b4f6-f5676c0117cd'
WHERE firm_id IS NULL;

CREATE INDEX IF NOT EXISTS chat_sessions_firm_idx
  ON chat_sessions (firm_id);

-- Verification:
--   SELECT count(*) FROM chat_sessions WHERE firm_id IS NULL;  -- expect 0

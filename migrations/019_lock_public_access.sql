-- 019_lock_public_access.sql
--
-- SECURITY: close the publishable-key door to client data (found 2026-10-24).
--
-- The Supabase PUBLISHABLE key (formerly "anon") is public by design: it is
-- compiled into the Word pane and Context Capture bundles. On 2026-10-24 it
-- could read 18 legacy tables (clients 19 rows, matters 44, documents 41 incl.
-- full contract text, matter_memory 1,284, chat_sessions 122, document_embeddings
-- 3,136, matter_document_chunks 537, chat_message_embeddings 577, usage_analytics
-- 953, ...) and call match_* / get_* RPCs that return client text — e.g.
-- match_matter_document_chunks_with_client returned rows, and
-- cleanup_duplicate_memories (DESTRUCTIVE) was GRANTed to anon in legacy
-- migration 006.
--
-- Cause: legacy migrations created `CREATE POLICY "Allow all operations on X"
-- ... USING (true)` with no TO clause (= role PUBLIC, i.e. anon + authenticated).
-- RLS was on, but those permissive policies OR'd with the ownership
-- policies from legacy 009 let anyone read everything.
--
-- ── What this migration does ──────────────────────────────────────────────
--
-- 1. For each LEGACY table below (verified against the live PostgREST schema
--    2026-10-24; missing tables are skipped with a NOTICE):
--      - ENABLE ROW LEVEL SECURITY (no-op where already on).
--      - Walk pg_policies and, per policy:
--          KEEP      service_role-only policies, and deny-all (USING false).
--          RE-SCOPE  ownership policies (USING/WITH CHECK references
--                    auth.uid()) that currently apply to PUBLIC/anon:
--                    ALTER POLICY ... TO authenticated. These are the
--                    `*_isolation` policies from legacy backend migration
--                    009 (clients, matters, playbooks, chat_sessions,
--                    documents: user_id = auth.uid(); matter_memory,
--                    matter_documents, matter_document_chunks,
--                    workspace_chats: via matters.user_id; playbook_history,
--                    negotiation_outcomes: via playbooks.user_id). They are
--                    used by the per-request user-scoped client in
--                    backend/src/middleware/auth.js and by audrey-tcp
--                    config-ui (Matters screen reads `matters` with the
--                    user's JWT). anon has auth.uid() = NULL, so they never
--                    matched anon rows anyway; re-scoping makes that explicit.
--          DROP      everything else that applies to anon/PUBLIC/authenticated
--                    without an auth.uid() ownership predicate — expected:
--                    every "Allow all operations on <table>" and
--                    "Allow all usage_analytics operations" (USING true).
--        Every decision is logged with RAISE NOTICE (policy names only).
--      - REVOKE ALL on the table FROM anon (belt-and-braces: even a future
--        permissive policy can't expose it to the publishable key).
-- 2. Safety sweep: any OTHER public base table with RLS disabled gets RLS
--    enabled (NOTICE only; its policies are not touched). On 2026-10-24 every
--    TCP table (audit_log, firms, firm_users, oauth_clients, oauth_codes,
--    positions, extraction_jobs, matter_decisions, document_handoffs,
--    whitelist) already had RLS on and returned 0 rows to the publishable key.
-- 3. Functions (all overloads, by name): REVOKE EXECUTE FROM PUBLIC, anon —
--    and FROM authenticated for every data-returning/mutating one (several
--    are SECURITY DEFINER, e.g. match_matter_memory, so RLS can't protect
--    them). GRANT EXECUTE TO service_role so server-side callers keep working:
--      legacy backend (now on the server-only key) and audrey-tcp
--      mcp-server (getSupabase() switched to SUPABASE_SERVICE_ROLE_KEY in
--      the same branch as this migration — deploy that FIRST).
--    is_user_whitelisted(text): boolean-only, but anon could probe whether
--    any email is on the access list. Callers: backend /api/auth/me and
--    requireWhitelist(), both via the service client. Revoked from
--    PUBLIC/anon; KEPT for authenticated and service_role.
-- 4. Storage bucket `documents` (created by 017, which may not be applied
--    yet): if it exists, force public = false and drop any storage.objects
--    policy that references it (017 intends deny-all; the backend uses the
--    service client + signed URLs). If absent: NOTICE only. Wrapped so a
--    permissions error on the storage schema can't abort the migration.
--
-- Idempotent: safe to re-run (second run logs "keep" for re-scoped policies
-- and finds nothing to drop). Forward-only; rollback notes at the bottom.
--
-- ORDER (see rollout): backend on SUPABASE_SERVICE_KEY and audrey-tcp
-- mcp-server on SUPABASE_SERVICE_ROLE_KEY must be DEPLOYED before this runs,
-- or their reads return empty.

BEGIN;

-- ============================================================
-- 1. Legacy tables: RLS on, anon policies gone, anon privileges revoked
-- ============================================================

DO $$
DECLARE
  legacy_tables text[] := ARRAY[
    -- leaking to the publishable key on 2026-10-24 (row counts visible)
    'chat_message_embeddings', 'chat_sessions', 'clause_cache', 'clients',
    'document_embedding_metadata', 'document_embeddings', 'document_types',
    'documents', 'generation_sessions', 'matter_document_chunks',
    'matter_documents', 'matter_memory', 'matters', 'playbook_history',
    'playbooks', 'precedent_analysis', 'usage_analytics', 'workspace_chats',
    -- empty on 2026-10-24 but created with "Allow all" policies (latent leak)
    'defined_terms', 'workspace_context', 'question_embeddings_cache',
    'generation_reviews', 'matter_answered_questions', 'negotiation_outcomes',
    'learned_patterns'
  ];
  t        text;
  kind     "char";
  pol      record;
  is_owner boolean;
  is_deny  boolean;
BEGIN
  FOREACH t IN ARRAY legacy_tables LOOP
    SELECT c.relkind INTO kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t;

    IF kind IS NULL THEN
      RAISE NOTICE '[019] table public.% not found — skipped', t;
      CONTINUE;
    END IF;

    IF kind IN ('v', 'm') THEN
      -- Views can't carry RLS; cut anon off at the privilege level.
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
      RAISE NOTICE '[019] public.% is a view — revoked anon privileges', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    FOR pol IN
      SELECT policyname, roles, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
    LOOP
      IF pol.roles = ARRAY['service_role']::name[] THEN
        RAISE NOTICE '[019] %.%: keep (service_role only)', t, pol.policyname;
        CONTINUE;
      END IF;

      is_deny  := coalesce(pol.qual, '') = 'false'
                  AND coalesce(pol.with_check, 'false') = 'false';
      is_owner := coalesce(pol.qual, '') ~ 'auth\.uid\(\)'
                  OR coalesce(pol.with_check, '') ~ 'auth\.uid\(\)';

      IF is_deny THEN
        RAISE NOTICE '[019] %.%: keep (deny-all)', t, pol.policyname;
      ELSIF is_owner THEN
        IF pol.roles = ARRAY['authenticated']::name[] THEN
          RAISE NOTICE '[019] %.%: keep (authenticated + auth.uid() ownership)', t, pol.policyname;
        ELSE
          EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated', pol.policyname, t);
          RAISE NOTICE '[019] %.%: re-scoped % -> {authenticated} (auth.uid() ownership kept)',
            t, pol.policyname, pol.roles;
        END IF;
      ELSE
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
        RAISE NOTICE '[019] %.%: DROPPED (roles %, no ownership predicate)',
          t, pol.policyname, pol.roles;
      END IF;
    END LOOP;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    RAISE NOTICE '[019] public.%: RLS enabled, anon privileges revoked', t;
  END LOOP;
END $$;

-- ============================================================
-- 2. Safety sweep: no public base table without RLS
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
       -- skip tables owned by an extension (e.g. postgis spatial_ref_sys)
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
      RAISE NOTICE '[019] sweep: enabled RLS on public.% (policies untouched)', r.relname;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '[019] sweep: could not enable RLS on public.% (%): check by hand', r.relname, SQLERRM;
    END;
  END LOOP;
END $$;

-- ============================================================
-- 3. Functions: no EXECUTE for anon (and none for authenticated on data RPCs)
-- ============================================================

DO $$
DECLARE
  -- Return client text/embeddings/stats, or mutate data.
  data_functions text[] := ARRAY[
    'match_matter_memory', 'match_matter_embeddings', 'match_document_embeddings',
    'match_matter_document_chunks', 'match_matter_document_chunks_with_client',
    'match_similar_memories', 'match_conversation_embeddings',
    'match_matter_conversation_embeddings', 'match_question_embeddings',
    'get_effective_playbook', 'get_matter_answered_questions',
    'get_matter_library_stats', 'get_clause_outcome_stats',
    'cleanup_duplicate_memories', 'cleanup_old_question_embeddings',
    'audrey_settle_decision'
  ];
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (data_functions)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
    RAISE NOTICE '[019] function %: EXECUTE revoked from PUBLIC/anon/authenticated; service_role only', fn.sig;
  END LOOP;

  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_user_whitelisted'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
    RAISE NOTICE '[019] function %: EXECUTE revoked from PUBLIC/anon; kept for authenticated, service_role', fn.sig;
  END LOOP;
END $$;

-- ============================================================
-- 4. Storage bucket `documents` (originals; created by 017)
-- ============================================================

DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE '[019] storage schema not present — skipped';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'documents') THEN
    RAISE NOTICE '[019] storage bucket "documents" not present (017 not applied yet) — 017 creates it private with no policies';
    RETURN;
  END IF;

  BEGIN
    UPDATE storage.buckets SET public = false WHERE id = 'documents' AND public;
    RAISE NOTICE '[019] storage bucket "documents": public = false';

    FOR pol IN
      SELECT policyname
        FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND (coalesce(qual, '') ~ '''documents''' OR coalesce(with_check, '') ~ '''documents''')
    LOOP
      EXECUTE format('DROP POLICY %I ON storage.objects', pol.policyname);
      RAISE NOTICE '[019] storage.objects.%: DROPPED (referenced bucket documents)', pol.policyname;
    END LOOP;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[019] storage: insufficient privilege (%). Check Storage > Policies for bucket "documents" by hand: it must be private with no anon/authenticated policies.', SQLERRM;
  END;
END $$;

COMMIT;

-- ============================================================
-- Verification (names/flags only — no row data)
-- ============================================================
-- Expect: every row rls_enabled = true, anon_select = false; policies listed
-- are only *_isolation (roles {authenticated}) or TCP firm/deny policies.

SELECT c.relname                                         AS table_name,
       c.relrowsecurity                                  AS rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT')      AS anon_select,
       coalesce(string_agg(p.policyname || ' ' || p.roles::text, ', '), '') AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
 GROUP BY c.relname, c.relrowsecurity, c.oid
 ORDER BY c.relname;

SELECT p.oid::regprocedure                                AS function,
       has_function_privilege('anon', p.oid, 'EXECUTE')    AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       p.prosecdef                                         AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND (p.proname LIKE 'match\_%' OR p.proname LIKE 'get\_%' OR p.proname LIKE 'cleanup\_%'
        OR p.proname IN ('is_user_whitelisted', 'audrey_settle_decision'))
 ORDER BY 1;

-- ============================================================
-- Rollback (emergency only — re-opens the leak)
-- ============================================================
-- Prefer fixing the caller (switch it to the server-only key). If a reader
-- you missed breaks and must be restored immediately, re-grant narrowly to
-- that table only, e.g.:
--   GRANT SELECT ON public.<table> TO anon;
--   CREATE POLICY "<table>_temp_anon_read" ON public.<table> FOR SELECT TO anon USING (true);
-- and drop both again once the caller is fixed. For an RPC:
--   GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO anon;

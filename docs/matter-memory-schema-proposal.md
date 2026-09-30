# AUD-601 — Schema proposal: decision records & working record

**For:** Raj sign-off · **From:** Sisi · **Date:** 2026-09-30
**Answers:** [matter-memory-spec.md](matter-memory-spec.md) §3 box
("Extend, do not duplicate") and tickets AUD-601/602/603.

## Recommendation (the short version)

1. **Decision records: a NEW table `matter_decisions`**, linked to
   `positions` by `position_id` where the decision is clause-shaped.
2. **The one supersession chain lives on `matter_decisions`.** When a
   linked decision is superseded, the same transaction stamps the
   linked position's `superseded_by` — positions' existing chain
   becomes a projection, and every existing tool
   (`get_position_history` etc.) keeps working unchanged.
3. **Working record: EXTEND `matter_memory`**, not a new table — it
   already has RLS, embeddings/search, the curation UI, and the
   cross-surface write path. Four added columns + one status value.

## 1. What exists today (verified against migrations + live repo)

**`positions`** (migration 008): `clause_type`, `value jsonb`,
`status ∈ proposed|open|settled|rejected`, `counterparty_name`,
`party_role`, provenance (`source_document_id`, `source_chunk_text`,
`extracted_at`, `extracted_by`, `confidence`, `raw_extract`),
`superseded_by → positions(id)`. Partial indexes on active rows.
Position history = walking `superseded_by`. **Missing for the spec:**
reasons, alternatives_rejected, reopen_conditions, settled_via /
settled_at / confirmation_text, source_tool/session stamping,
`proposed → settled` user-act semantics (today extraction or
`add_position` writes status directly).

**`matter_memory`** (legacy table + migration 006 firm backfill):
`user_id` + `firm_id` dual-tag, `matter_id`, `memory_type`, `content`,
`scope`, `status ∈ pending|endorsed|dismissed|retired` (+ `active`
for Stage B chunks), `source_document_id`, `embedding vector(1536)`,
`embedding_model`. Served by `match_matter_memory` (009/010), the
Notes curation UI, and `add_matter_note`. **Missing for the spec:**
`kind`, server-stamped `source_tool`/`source_session_id`,
`promoted_to`, `dismissed_at` as a timestamp (today dismissal is a
status), a `captured` status for auto-capture.

## 2. Options considered

**A. Extend `positions` with decision fields.** Rejected: two
lifecycles in one table (negotiation stance vs settled-decision
record), heavy nullable columns on thousands of extraction rows, and
non-clause decisions ("client instructed we sign by Friday",
concession trades) would need a fake `clause_type`. The table's
consumers (extraction pipeline, three read tools) would all need
guards against decision-only rows.

**B. New `matter_decisions` linked by `position_id`. Recommended.**
Decisions are a different thing with a different lifecycle
(`proposed → settled → superseded|dismissed`), different writers
(user acts, never extraction), and different readers (conflict
detection wants reasons; position tools want values). The spec's own
fields map 1:1 onto a clean table. Linkage where clause-shaped;
standalone where not.

**C. Decisions inside `matter_memory`** (a `kind='decision'` with
JSON payload). Rejected: burying reasons/supersession/confirmation in
a jsonb blob defeats querying ("all settled decisions with reopen
conditions touching liability"), and mixes authoritative records into
a table whose UI affordance is dismissal.

## 3. The one-chain design (the spec's hard requirement)

- `matter_decisions.supersedes_id / superseded_by_id` is **the**
  chain. Superseded rows retained, never deleted.
- One service-layer function — `settleDecision()` /
  `supersedeDecision()` in a new `decisionsRepository` — is the only
  writer of chain state. When `position_id` is set, the SAME
  transaction: (a) writes the new position snapshot, (b) stamps the
  old position's `superseded_by`, (c) links decision → new position.
  Positions' chain is thereby a projection of the decision chain —
  one source of truth, zero changes to existing read tools.
- **Satellite path:** when `add_position` (or its successor) would
  supersede a settled position without a decision in hand, the
  service auto-creates a minimal decision shell (`reasons: ['reasons
  not recorded']`, `settled_via` = the calling tool) so no
  supersession event ever exists outside the chain. Under the spec's
  settle rules this path also requires the explicit-user-act flag.

## 4. Draft DDL (migration 014 — for review, not yet to run)

```sql
CREATE TABLE IF NOT EXISTS matter_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL,
  matter_id           uuid NOT NULL REFERENCES matters(id),
  user_id             uuid,                       -- RLS parity with matter_memory

  decision            text NOT NULL,              -- one sentence
  reasons             text[] NOT NULL DEFAULT '{}',  -- 1..3 short reasons
  alternatives_rejected jsonb NOT NULL DEFAULT '[]', -- [{option, why_rejected}]
  reopen_conditions   text,

  position_id         uuid REFERENCES positions(id),
  source_document_id  uuid REFERENCES documents(id),  -- "decided while working X"

  status              text NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','settled','superseded','dismissed')),

  -- provenance: stamped SERVER-SIDE from the authenticated client
  source_tool         text NOT NULL,              -- 'audrey_word' | 'claude' | 'cowork' | 'migration' | ...
  source_session_id   text,
  proposed_at         timestamptz NOT NULL DEFAULT now(),

  -- the explicit user act
  settled_via         text,
  settled_at          timestamptz,
  confirmation_text   text,                       -- user's words when settled outside the taskpane

  supersedes_id       uuid REFERENCES matter_decisions(id),
  superseded_by_id    uuid REFERENCES matter_decisions(id),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settled_needs_act CHECK (
    status <> 'settled' OR (settled_via IS NOT NULL AND settled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS matter_decisions_active_idx
  ON matter_decisions (firm_id, matter_id)
  WHERE status IN ('proposed','settled');

-- Working record = matter_memory, extended (AUD-602 becomes ALTERs):
ALTER TABLE matter_memory
  ADD COLUMN IF NOT EXISTS kind text
    CHECK (kind IS NULL OR kind IN ('note','reasoning','context','open_question')),
  ADD COLUMN IF NOT EXISTS source_tool text,
  ADD COLUMN IF NOT EXISTS source_session_id text,
  ADD COLUMN IF NOT EXISTS promoted_to uuid REFERENCES matter_decisions(id),
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
-- status vocabulary gains 'captured' (auto-capture; invisible to the
-- endorsed/pending curation view until promoted or surfaced).
```

DB-level `settled_needs_act` enforces AUD-632's server-side rejection
even against a buggy code path. RLS: both tables carry the
`user_id` + `firm_id` dual-tag; policies mirror `matter_memory`'s
(legacy user-scoped) plus firm-scoped service access — AUD-105
two-account runbook extends to both (flagged in acceptance criteria).

## 5. Migration of existing memory (AUD-605 mapping — for sign-off)

- `matter_memory` rows, `memory_type='decision'`, status `endorsed`
  → settled `matter_decisions` (`reasons: ['reasons not recorded']`,
  `source_tool='migration'`, `settled_via='migration'`,
  `settled_at=created_at`). Original row gets `promoted_to` set —
  nothing deleted.
- `preference` / `context` rows stay in the working record as-is
  (`kind` backfilled from `memory_type` where it maps; else 'note').
- Stage B `chunk` rows untouched.

## 6. Knock-on shapes (so tickets scope cleanly)

- **AUD-602/603** become: ALTERs above + `matter_decisions` + a
  `decisionsRepository` (list/propose/settle/supersede/dismiss).
- **AUD-604:** `source_tool`/`source_session_id` derive from the
  authenticated request (OAuth client + session for MCP; app identity
  for the taskpane path) — never from model-supplied args.
- **AUD-631 tool shapes:** `capture_note{matter_id, content, kind}` →
  working record; `propose_decision{matter_id, decision, reasons?,
  alternatives_rejected?, reopen_conditions?, position_ref?}` →
  status proposed; `settle_decision{decision_id | inline fields,
  user_confirmed: true, confirmation_text}` → the service function.
- **AUD-634:** `add_matter_note` becomes an alias of `capture_note`
  (kind='context') — keep the old name advertised for one release,
  then retire; `add_position` requires the user-act flag when it
  would settle or supersede, else it proposes.

## 7. Sign-off checklist (Raj)

1. Option B (new `matter_decisions` + position linkage + chain design
   in §3) — approve or redirect.
2. AUD-605 mapping rules in §5 — in particular that `preference` rows
   stay working-record rather than becoming decisions.
3. `source_document_id` on decisions (§4) — small addition beyond the
   spec, aligning with the "conversation against each document"
   ruling; keep or strike.
4. Then I finalise migration 014 and open the Stage 1 build.

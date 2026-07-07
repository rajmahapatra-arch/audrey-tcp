# Audrey App restoration — Phase A plan

**Status:** Phase A (audit) complete, 2026-07-06. This document is the
deliverable: what the audit found, the target architecture, the
keep/strip/build lists with citations, the auth decision, and the
Phase B work plan.

**Decision this implements** (agreed 2026-05-25): two surfaces, one
product. The **Audrey App** (Word taskpane + backend) is the *drafting
studio* — matter selection, document review, surgical markup,
position/note curation, no conversational chat thread. The **Audrey
TCP plugin/connector** is the *satellite* — matter intelligence and
capture from any Claude surface (Word sidebar, Desktop, claude.ai,
mobile — all four empirically verified). One shared Supabase database
is the spine.

All file:line references are to the legacy repo
(`word-ai-assistant/word-ai-assistant/`) at commit `a7e8b73` unless
prefixed `tcp:`.

---

## 1. What the audit found

Three parallel deep-reads (taskpane anatomy, edit-apply engine,
backend dependency map). Compressed findings:

### The taskpane (`word-addin/`)

One 5,350-line monolith (`src/taskpane/index.jsx`) plus satellites.
Regions:

| Region | Lines | Verdict |
|---|---|---|
| Chat thread UI + SSE streaming + task planning | 4055–4393 | **Strip** |
| Edit cards (`RedlinePreview`) + parse + **apply engine** | 441–776, 1881–2053, 2295–2966, 3053–3373 | **Keep** (extract from chat state) |
| Matter select/bind/doc-detect (Word custom property `AIAssistantMatterId`, folder-path matching) | 1043–1225, 4489–4567 | **Keep** |
| Document navigator + defined-terms extraction | 1226–1302, `DocumentNavigator.jsx` | **Keep** |
| Playbook card/editor | 4525–4541, `PlaybookCard/Editor.jsx` | **Keep** (untouched; loosely coupled) |
| Memory endorsement toasts in chat stream | 4264–4275 | Strip (superseded by Notes panel) |
| `workspaceStorage.js` (IndexedDB) | all | Legacy fallback only — backend is authoritative; leave as-is |

### The edit-apply engine (the crown jewels)

Battle-tested across five hard bug-fix commits (`a7e8b73` empty-doc
INSERT, `411eb5a` heading-aware paragraph index, `73c00df`
OOXML-tracked-changes strategy, `a8f8fb1` apply-flow fixes, `bac8718`
author stamping). Pipeline:

```
edit object → applyEdit() [3053]
  → applyEditWithBookmark() [2295]
      anchor: paragraph-index bookmarks (_audrey_p_<n>, bookmarkManager.js)
      fallback ladder: scoped search → full-paragraph match → body-wide search → fail
      Strategy 0 [2499–2855]: word-level diff (diffWordsWithSpace) →
        hand-built <w:del>/<w:ins> runs, author-stamped
        (coauthoring.me.name), injected via insertOoxml with tracking
        toggled OFF→ON
      Strategies 1–3: insertText replace / body search / OOXML string replace
  → verifyEditApplied() [3005] → comment attach [3112] → refreshBookmarks()
```

Reusability: **~600 lines carry unchanged** (bookmarkManager, Strategy
0, fallback ladder, write-lock discipline). The chat-coupled wrapper
(retry/messaging around React `messages[]` state, batch selection via
`selectedEditIds`) needs a bounded refactor. Dead weight: the legacy
no-bookmark path `applyEditWithOoxml()` [2159–2291].

Office.js constraints to respect (hard-won knowledge):
- `range.getOoxml()` throws on empty ranges — check/skip first
- `insertOoxml` with tracking ON wraps everything in one outer ins/del
  — must toggle tracking off for surgical injection
- Word search API 255-char limit — truncate search terms
- Paragraph indices go stale after insertions — `refreshBookmarks()`
- Replacements must apply in reverse document order

### The backend (`backend/src/server.js`, ~3,950 lines)

- **~42% is chat/AI-generation** — `/api/chat` [689–1031],
  `/api/chat/stream` [1032–1636], `/api/chat/plan` [1637–1702], plus
  `systemPrompts.js` and `conversationEmbeddings.js`. All strip.
- **Everything the studio needs survives untouched**: matter/doc CRUD,
  the full memory endpoint family (list/add/endorse/dismiss/edit/
  scope) — operating on the same `matter_memory` table TCP's
  `add_matter_note` writes with `status='pending'`. The cross-surface
  notes loop lands in the App for free.
- **Deployment**: one Express app serves `word-addin/dist` at `/`,
  `context-app/dist` at `/context`, and `/api/*` [465–480]. The
  restored App redeploys to `app.audrey.xeqtor.com` with zero topology
  change.
- **Auth**: middleware validates **Supabase-issued JWTs only**
  (`serviceClient.auth.getUser`, middleware/auth.js:90), currently in
  transition mode (`REQUIRE_AUTH=false`). TCP's RS256 JWTs will not
  validate here. See §3.

---

## 2. Target architecture — the drafting studio

```
┌────────────────────────────────────────────────┐
│  Audrey taskpane (Word)                        │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ Matter header (always visible)           │  │
│  │  Elion · NDA · In negotiation      [⚙]   │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Since you were here (activity feed)      │  │
│  │  • 2 new notes (phone, yesterday)        │  │
│  │  • 1 position settled                    │  │
│  │  • handoff: "was tightening indemnity…"  │  │
│  └──────────────────────────────────────────┘  │
│  [ Review document ]  ← the one big button     │
│  ┌──────────────────────────────────────────┐  │
│  │ Edit pool (cards)                        │  │
│  │  each: diff view · Apply · Show · Dismiss│  │
│  │  [Apply selected]                        │  │
│  └──────────────────────────────────────────┘  │
│  Tabs: Positions · Notes · Documents · Playbook│
└────────────────────────────────────────────────┘
         │ Supabase JWT (unchanged)
         ▼
  legacy backend (chat endpoints stripped)
         │ server-to-server, INTERNAL_API_KEY
         ▼
  TCP server: POST /api/review
    = check-draft extraction (existing)
    + settled-position deviation compare (existing)
    + wordDiff tighten (existing)      → edit objects
```

Key design points:

1. **Matter confidence is chrome, not conversation.** The header is
   the permanent answer to "am I in the right matter?" — the thing
   Claude for Word structurally can't provide.
2. **Review is a button, not a prompt.** It calls one endpoint; edit
   suggestions arrive as apply-ready objects (already tightened by
   `tcp:mcp-server/src/editing/wordDiff.ts`); Strategy 0 lands them
   surgically. Deterministic end to end — the surgical outcome is
   *guaranteed* here, unlike the TCP surface where `tighten_edits` is
   advisory.
3. **Edit pool replaces `messages[]`.** Standalone
   `editPool: Edit[]` state + pure `applyEditAsync(edit)` extracted
   from `applyEdit(messageId, editId)`. Same engine, no chat.
4. **Panels read what the satellite writes.** Positions panel →
   `positions` table (TCP add_position + Stage B extraction). Notes
   panel → port `LearnedMemories.jsx` from context-app (endorse/
   dismiss/retire already built) → shows TCP `add_matter_note` rows
   pending curation. Activity feed → timestamps across positions /
   matter_memory / documents / document_handoffs.

## 3. The auth decision

**Recommendation: Option A — keep Supabase auth for the App;
server-to-server secret for the one new cross-system call.**

- The App's Microsoft-OAuth-via-Supabase sign-in works and is verified
  in production (AUD-201/202). Zero migration risk.
- The taskpane never needs to call TCP directly. The single new
  dependency (review) goes legacy-backend → TCP over a plain REST
  endpoint guarded by a shared secret (`INTERNAL_API_KEY` env on both
  services). One implementation of extraction+diff stays in TCP; no
  JWT bridging; no user-facing auth change.
- Unification (App adopts TCP's OAuth) remains possible later; it
  buys nothing today and costs ~2 days plus re-verification.

Rejected: Option B (unify now) — cost without benefit while the App
and TCP backends stay separate services against one database.

## 4. Strip list (Phase B deletions)

Frontend (`word-addin/src/taskpane/index.jsx`):
- Chat thread UI, `sendMessage()`, SSE handling, task-plan gate
  [4055–4393]; message rendering [5046–5089]; memory toasts
  [4264–4275]; `parseEditsFromResponse()` [1881–2053] (edits now
  arrive structured from `/api/review`); legacy
  `applyEditWithOoxml()` path [2159–2291]; failure-UI chat
  instructions [3169–3211].

Backend (`backend/src/server.js`):
- `/api/chat`, `/api/chat/stream`, `/api/chat/plan` [689–1702, ~1,000
  lines]; `/api/matters/:id/chat` save/load [3576–3598];
  `systemPrompts.js` (+ the three `_old_*.js` variants);
  `conversationEmbeddings.js`. Keep `semanticSearch.js`,
  `documentEmbeddings.js`, `pdfProcessor.js` (library features).

## 5. Build list (Phase B additions)

| Item | Where | Est |
|---|---|---|
| B1. Edit pool + `applyEditAsync(edit)` extraction (pure fn, keeps lock/verify/revert), batch apply generalised | taskpane | 1.5d |
| B2. Chat strip + layout reshuffle (header, button, tabs) | taskpane | 1.5d |
| B3. `POST /api/review` on TCP (REST, INTERNAL_API_KEY guard): check-draft + settled-position compare + wordDiff tighten → edit objects; legacy-backend proxy route | tcp + backend | 1d |
| B4. Review cards wired to edit pool (reuse `RedlinePreview` minus chat props) | taskpane | 0.5d |
| B5. Positions panel (read `positions` via new `GET /api/matters/:id/positions` on legacy backend — table already shared) | backend + taskpane | 0.5d |
| B6. Notes panel — port `LearnedMemories.jsx` from context-app (endpoints already exist) | taskpane | 0.5d |
| B7. Activity feed — `GET /api/matters/:id/activity` aggregator (positions + memory + documents + document_handoffs since last open; "last open" from Word custom property) | backend + taskpane | 1d |
| B8. Backend strip + smoke of surviving endpoints | backend | 0.5d |
| B9. Integration pass on 2–3 real matters (Elion NDA, a KBR matter) with real redline round-trips | — | 1d |

**Phase B total: ~8 days.** Phase C (deploy to app.audrey.xeqtor.com,
live on it for a week, then pilot-ready call): deploy is same-topology
so ~0.5d plus the live week.

## 6. Risks

1. **Office.js regressions while refactoring the apply wrapper** — the
   engine core is untouched but the wrapper rewrite (B1) can
   reintroduce fixed bugs. Mitigation: keep the five-commit failure
   modes as a manual test checklist (empty doc, stacked inserts,
   apply-all ordering, revert, author stamping).
2. **Review quality** — check-draft extraction was tuned for position
   extraction, not general markup suggestions. First iteration may
   need a review-specific prompt in TCP. Budget half of B9 for prompt
   iteration.
3. **Two backends, one database** — schema changes now have two
   consumers again. Rule: migrations continue to live in tcp/
   migrations only; legacy backend adapts.

## 7. Out of scope (parked, with triggers)

- Client/matter merge tooling → config-ui backlog (trigger: next
  duplicate-client incident after the SQL cleanup).
- Embedding-store unification (`matter_document_chunks` vs
  `matter_memory`) → trigger: cross-surface search of library docs.
- Plugin marketplace distribution → after the App is the proven studio.
- Pivot-memo rewrite to "two surfaces" narrative → before first pilot
  conversation (small, do during Phase B).

## 8. Open questions — RESOLVED (defaults taken 2026-07-06 to unblock Phase B)

1. **Playbook tab: stays visible in v1.** It's decoupled, its
   endpoints survive the strip, and removing working functionality
   buys nothing.
2. **Review scope: whole-document only in v1.** Selection-scoped
   review is a clean additive for v1.1.
3. **No deploy freeze.** All Phase B work happens on a
   `studio-restoration` branch in the legacy repo; `main` remains the
   deployable legacy app (chat intact) until the Phase C cutover
   merge. Emergency fixes land on main as normal.

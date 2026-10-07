# Competitive teardown: Eigenwelt Labs — LegalWork & LegalMemory

**Date:** 2026-10-07 · **Author:** Sisi (static source review) · **For:** Raj
**Method:** read-only review of the public source; nothing executed. LegalWork `dev` @ 8858075 (v0.2.4 era), LegalMemory `main` @ 69817de (v0.1.0). Clones under `%LOCALAPPDATA%\Temp\ew-eval\` (disposable). Raj's downloaded installer `legalwork-win-x64-0.2.4.exe` verified against the release `SHA256SUMS` — **authentic, but not code-signed**.

---

## 1. Verdict in five lines

1. **Audrey's moat survives contact.** Neither product distinguishes user-settled from model-proposed knowledge. Our decision records — settled only by an explicit lawyer act, with reasons, alternatives rejected, reopen conditions, one supersession chain — exist nowhere in their stack.
2. **LegalMemory, not LegalWork, is the one in our lane** — and it's AGPL-3.0: read and learn, never copy (rules in §8).
3. **LegalWork is an OpenCode fork** (agent engine is not their code) wrapped in genuinely good legal UX. Its Word add-in is a localhost-served chat pane with matter-scoped chat and exact-text-only edit anchoring — weaker than our pane on both counts.
4. **They out-discipline us on evaluation and provenance**; we should copy the discipline (receipts, frozen-gold benchmarks, correction scoping), not the breadth.
5. The lane is crowding (Eigenwelt, Elion's EKG, Anthropic's Claude for Legal). The defensible position stays: **the human-settled decision layer, captured at the moment of decision, in Word.**

## 2. Who they are

Berlin lab ("a lab for cognitive architectures"), operating company Poensgen Technology UG, trading as Eigenwelt Labs. Open-core: MIT desktop app + AGPL knowledge appliance + paid platform (Sync €15, Plus €29 incl. €30 AI, Pro €69 incl. €70 AI, per seat/month). Pricing brackets our £25–50 individual plan — useful comp. Active: v0.2.4 shipped 2026-10-06; 117 stars; CLA lets them dual-license.

## 3. LegalWork (MIT) — what it actually is

### Lineage & architecture
- Fork of Different AI's **OpenWork**, running the **OpenCode** engine binary (v1.18.29) as a sidecar — the agent loop, tool-calling, and permissions are OpenCode's, not theirs. Their code is plugins + UX.
- **Electron** 43 (README's "Tauri" is stale; they migrated). ~378 MB because it bundles a second Node runtime, two Bun sidecars, ONNX/OCR/audio native addons, two full React builds (app + Office pane), ~15 font families. **No model weights bundled**; speech/OCR models download on demand (speech downloads unpinned, no checksums).
- Monorepo: `apps/desktop` (Electron shell), `apps/server` (~59k-line embedded server: SQLite stores, Office relay, OCR, reviews, calendar, sync), `apps/app` (~145k-line React UI, triple-built), `apps/orchestrator` (headless; zero tests), Slack/Telegram bridge, macOS-only computer-use runtime.

### The Word add-in (most comparable to us)
- Same React chat UI served at `https://localhost:47443/word-addin/` by the desktop app; per-install name-constrained CA trusted into the OS; registry/sideload install only. **Store-installed Office refused; desktop app must be running.** Not AppSource-distributable as built.
- Agent→pane transport is HTTP long-polling through a relay keyed by **(workspace, host) — not by document**. Documented consequence: with two Word docs open in one matter, an edit can land in the wrong document. **Our chat-per-document design avoids this class of bug structurally.**
- **Chat is matter-scoped** (workspace folder), auto-matched by file path — and the path matching likely breaks on Windows paths and OneDrive/SharePoint URLs (forward-slash-only match; `http(s)` URLs skipped; no Windows CI).
- Three edit backends with hard routing guards (in-app editor → live Word → file pipeline):
  - **Live Word:** plain Office.js `body.search` + Range ops. Anchors are **verbatim text only, ≤240 chars, single paragraph, case-sensitive, no normalization** (smart quotes/NBSP must match exactly). Failure → model-readable error, re-read and retry; no fuzzy fallback.
  - **Tracked changes ladder:** WordApi ≥1.4 flips `changeTrackingMode` around the edit (real native revisions, authored as the signed-in user); older Word gets a hand-built `w:ins`/`w:del` Flat-OPC insert that **drops run formatting** and flattens fields/footnotes; last resort applies untracked with a warning.
  - Reasons for edits are **loose Word comments near the anchor, not linked to the revision**, authored inconsistently ("LegalWork", "LegalWork AI", "Eigenwelt Reviewer", or the user, depending on path).
  - In-app/file pipeline use a **deprecated** third-party ProseMirror DOCX engine (`@eigenpal`, locally patched) — proper revision marks with run properties preserved, paraId+search anchoring; file mode applies partial plans (failed ops dropped into an errors list).
- `word_run_code`: the model writes arbitrary Office.js executed in the pane via `new Function` — explicitly "not a security boundary."

### Memory & the correction loop
- Their agent-memory plugin was **removed** ("nothing reads them any more"). What persists: per-project instructions (edit requires approval), skills/workflows, chat transcripts (substring recall), and **LegalMemory over MCP, which the agent is told to consult "BY DEFAULT"**.
- **Lessons:** corrections are classified (extracted fact | matter-specific exception | reusable rule | code defect), saved with scope (project/global), **hash-pinned to the base skill** (base changes → lesson refuses to load until rebased), carrying a fixed example + a must-not-change example. Good design.
- **Receipts:** deadline calculations run hash-pinned code, return server-issued receipts (inputs, rule+version, code hash, timezone); the agent can only cite receipt IDs, never substitute arithmetic; evidence = path+page+quote bound to file hash, re-verified at save; overrides require reasons. They regression-test against two published German calculators.
- Pockets of settled-vs-provisional exist locally (calendar `verified` flags, calculation card states with `supersedes`, review cells `needs_review`), but **no general concept, and nothing a lawyer "settles" with reasons.**
- No embeddings in LegalWork; "semantic search" = per-document yes/no classification via their cheap SystemOne/JEV classifier API.

### Network, telemetry, secrets, gating
- Calls home: PostHog EU (analytics), eigenweltlabs.com (updates), platform.eigenweltlabs.com (catalog, OAuth, hub/sync/calendar/intake), api.eigenweltlabs.com (SystemOne + inference gateway), Hugging Face (models), GitHub (skills/plugins), Microsoft CDN (office.js).
- **Telemetry: opt-out model** (toggle defaults on) but nothing sends until the welcome screen commits the choice; no message content; per-launch rotating anonymous ID; city-cap GeoIP. Caveat: the **inference gateway carries the same analytics ID header**, linking inference traffic to the analytics identity within a launch.
- **Secrets on disk are weak:** no OS keychain anywhere; provider keys in OpenCode's plaintext `auth.json`; gateway key + bearer written into config files; OAuth tokens in plaintext SQLite columns; one AES vault whose key sits next to it by default.
- **Recorder/call-copilot:** transcription is genuinely local, but the copilot sends the **full live call transcript** to the configured LLM, project-linked recordings sync to firm storage (their TERMS still claim audio/transcripts never leave the device — stale), and the overlay uses `setContentProtection(true)` — their own comment: "Cluely-style discretion," invisible in Zoom/Teams screen shares. No consent UX; TERMS push §201 StGB liability to the user. **A law-firm IT reviewer will flag all of this.**
- Tier gating is server-side (per-user gateway keys, entitlement checks per call); no license checks in the MIT code. Honest open-core.
- Defaults are permissive: approval mode `auto`, broad tool permissions, `cors *` on the local API (their `/word-addin/bootstrap` hands the pane both client and host tokens, defended only by same-origin-by-construction; the name-constrained localhost CA mitigates DNS rebinding, but it deserves a pentest).

### Quality read
Real strengths: candid run audits in-repo, a Harvey Legal Agent Benchmark harness with ablations, deadline regression fixtures, Electron hardening + fuses, 3-day npm release-age floor, DCO. Corners: 5.5k-line god files, engine `fetch` monkey-patches, deprecated core editor dependency, stale docs/TERMS, no real-Word CI (LibreOffice only), no Windows unit CI, orchestrator untested, Windows alpha builds may ship unsigned.

## 4. LegalMemory (AGPL) — the one in our lane

A self-hosted, **read-only** "shadow index" of a firm's documents: 16-service Docker appliance (Postgres+pgvector, OpenSearch, Keycloak, LiteLLM, Docling OCR, Hatchet workers), German-first, permission-obsessed. Agents consume it via **20 read-only MCP tools**; a lawyer cannot write, confirm, or correct anything (no write routes for knowledge, no approval states; their docs defer a review UI to "eventually").

- **Data model (47 tables):** sources→blobs→derived artifacts; knowledge layer of matters/clients/parties/documents/**versions** (draft/final/executed with evidence, redline pointers, latest-final), typed document-to-document edges (annex_of/amends/supersedes/references/responds_to) — relational, not a true graph; edges don't affect ranking. **Provenance is excellent:** every inferred row carries model, prompt version, confidence, evidence, trace ID. Matter labels use a confidence-weighted vote with a stored **"contested" score**. Temporal validity is weak ("decay by supersession, not by age").
- **Their decision records:** machine-extracted per document version from tracked changes + comments — clause locus, change summary, rationale category (legal_risk | market_standard | negotiation_concession | regulatory_requirement | drafting_error | client_instruction | tactical), **anonymized** rationale, generalizable flag. No reasons from the lawyer, no alternatives, no reopen conditions, no chain, no human act; any re-run can overwrite. Decision *search* is a naive word-overlap full scan (won't scale).
- **Retrieval:** permissions compiled into every query **before** ranking (deny wins, unknown invisible, fail-closed access log); three-leg RRF (BM25 + HNSW vector + an **exact-identifier leg** weighted 1.5); status boosts (executed 1.2 > final 1.0 > unknown 0.8 > draft 0.7); one hit per logical document; optional LLM rerank that reorders but never drops. Embeddings: **text-embedding-3-small @1536 — identical to our eval-decided choice.**
- **Ingestion:** 7-stage durable pipeline (Docling convert; a dedicated pass pulls **tracked ins/del/moves + comments from raw Word XML**; agentic matter-classify/relate/metadata against the 18k-node SALI ontology; decision extraction; chunk 1200/120 with embedding-only context headers).
- **"Continual learning" is branding, not code:** no feedback/correction endpoints, no training hooks. What exists: re-derivation on version bumps, remembered alias judgments, and an RL-environment builder (partner-approved benchmark tasks from the firm's own work product) that nothing consumes yet. Their evaluation discipline, though, is real: frozen gold sets, naive-vector baseline as a ship gate, permission-leak checks, significance tests.
- Maturity: production-minded engineering, v0.1.0 reality — no named customer visible; docs run ahead of code in several places.

## 5. The moat verdict

Across both products there is **no primitive for "the lawyer decided this, for these reasons, and it stays decided until superseded by another human act."** LegalMemory's whole knowledge layer is re-derivable model output; LegalWork's in-Word reasons are unlinked comments; the two pockets of confirmation they do have (calendar dates, benchmark tasks) prove they understand the concept and haven't built it for matter knowledge. Audrey's working-record/decision-record split, the explicit settle act, and reasons-that-travel-with-the-record are a different primitive — and for lawyers, the trustworthy one. They are also behind us on capture-from-conversation: their index only knows what's in files; Audrey writes the negotiation as it happens.

Positioning sentence that survives this review: **"Audrey is the system of record for what you decided and why. Everything else is search."**

## 6. What we adopt (independent re-implementation only)

**A-list — maps onto current stages:**
1. **Cache-stable context injection** (LegalWork): fixed system prompt; live matter/document state as topic-keyed reminder blocks appended only when changed. They measured ~0%→85% prompt-cache hits. Directly applicable to `/api/chat` + our settled-decisions block. *(S2 refinement)*
2. **Contested → settle** (LegalMemory): when extraction/labels disagree, store a contested score and surface it as a "settle this" decision-card trigger. Cheap; feeds our core act. *(S2e/AUD-619 adjacent)*
3. **Receipt pattern** (LegalWork): server-issued evidence IDs binding file hash + locus + exact quote; the model cites receipt IDs and cannot restate the facts; agent judgment labelled separately. Apply to decision cards and AUD-621 conflict citations. *(Stage 3)*
4. **Correction scoping taxonomy** (LegalWork): classify a lawyer's correction as extracted fact | matter exception | reusable rule | defect; propose scope; hash-pin firm rules to their base playbook; keep a fixed case + a must-not-change case. Maps to working record → playbook graduation. *(Stage 3)*
5. **Edit-engine benchmark in CI** (their discipline, our engine): anchor hit rate, run-property preservation, tracked-change guarantee, across real fixture docs. We claim "battle-tested" — prove it continuously, and publish the anchor success rate as marketing.

**B-list — backlog with triggers:**
6. **Document version chains**: logical doc vs version, draft/final/executed with evidence, redline pointers, latest-final; tie positions to "which turn of which draft." *(with the next extraction iteration)*
7. **OOXML tracked-changes as capture signal**: mine w:ins/w:del/comments on upload as position/decision candidates — our home turf; they got there first. *(post-Stage 3; feeds proposals, never settles)*
8. **Retrieval upgrades**: RRF keyword+vector + an exact-identifier/defined-term leg (Postgres FTS beside pgvector); status boosts (settled>proposed, executed>draft); chain-head collapse; per-doc profile rows; frozen-gold eval with a naive-vector ship gate (extends AUD-607). Filter before vector search, not after (their documented pgvector/HNSW recall lesson).
9. **Trust wedge checklist** for pilot IT reviews — the list they'd fail: no plaintext secrets (we're server-side; keep it that way), explicit consent UX, opt-in telemetry, signed identity, pinned downloads, Host/Origin validation.

## 7. What we don't chase

Tabular review, voice/recorder, Excel/PPT panes, fusion mode (prompt-level theater — no real reconciliation code, per-candidate model routing possibly cosmetic), macOS computer use, German deadline engines, their breadth generally. Depth wins the lane we picked.

## 8. Licensing guardrails (standing rules)

- **LegalWork (MIT):** may read, learn, adapt with attribution. Prefer concept-level adoption anyway.
- **LegalMemory (AGPL-3.0): never** copy, translate, or closely paraphrase its code, prompts, schemas, or docs into Audrey; never vendor/link the package; running it for clients would trigger the network-source clause. Ideas and architecture described in prose are free to re-implement independently. Its MIT-derived parts (Airweave connectors, harvey-labs agent loop) are takeable **from their original upstreams only**. If we ever wanted the real thing embedded: they sell commercial licenses. *(Not legal advice; Raj to confirm — he's the lawyer.)*
- Keep this doc's findings as the clean-room intermediary: implement from the descriptions here, not from their source.

## 9. Hands-on protocol (when you want to feel the product)

1. **Windows Sandbox only** (Win 11 Pro: enable "Windows Sandbox" feature if not already, launch, drag `legalwork-win-x64-0.2.4.exe` in). Unsigned binary + v0.2.x + your dev machine's Office/add-in setup = never the main profile.
2. In sandbox: decline telemetry at the welcome screen if you prefer; connect **no real accounts**; feed it **dummy documents only** — no client papers into any third-party eval, ever.
3. Worth 45–60 minutes of feel: onboarding; the matter-folder model; a chat in a matter; the in-app DOCX redline flow (accept/reject); tabular review on 3–4 dummy contracts; trigger a correction and watch the "lesson" proposal; the deadline calculator receipts UX.
4. **Skip their Word add-in on real hardware** — it needs the desktop app running + a trusted localhost CA + registry sideload (and Sandbox has no Office). We've judged it from source; if you ever truly want it live, a spare VM with Office.

## 10. Landscape footnote

- **Elion "EKG" (Elion Knowledge Graph):** third-party matter-knowledge connector found attached to Raj's claude.ai account 2026-10-07 (tools incl. commit_decision, get_conflicts, link_channel_to_matter); disabled same day at Raj's instruction. Another entrant in the decision/governance lane — worth a look if it resurfaces in the market.
- **Anthropic Claude for Legal** (May 2026): 12 practice plugins + 20+ connectors + M365 embed. Platform, not matter memory — remains the distribution rail our TCP strategy rides, and the reason Audrey stays *above* the plugins.

---
*Sources: static review of the two public repos (paths above); release metadata from github.com/eigenweltlabs; product pages at eigenweltlabs.com. Full file-level citations live in the session transcript of 2026-10-07.*

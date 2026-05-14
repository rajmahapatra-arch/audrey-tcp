# Audrey TCP — implementation plan

Working plan for the Audrey TCP (The Claude Plugin) pivot, derived from
the May 2026 strategic spec (`Audrey_TCP_Spec.docx`) plus subsequent
decisions captured in the Sisi briefing.

Last updated: 2026-05-12

---

## Why this exists, in one paragraph

Anthropic shipped Claude for Legal on 12 May 2026 — twelve practice-area
plugins, MCP connector support, Word add-in surface, all open-source
under Apache 2.0. That bundled what we were building Audrey to do at the
*surface* layer. Continuing to iterate the Word taskpane is a battle
against Anthropic's distribution we cannot win. **Audrey TCP moves the
product above Anthropic's plugins**: a per-matter, per-counterparty,
per-client intelligence layer that plugs into Claude for Microsoft 365
via the open MCP and plugin surfaces. We ride their distribution, not
fight it. The schema is the moat — Anthropic's plugin model cannot reach
per-matter persistent state, so we own that layer.

---

## What's paused (and why it matters that "paused" not "deleted")

### From the existing Audrey codebase

- **Word taskpane** (`word-addin/src/taskpane/`) — primary surface no
  longer; archive on shelf. Existing recent work on edit-application
  (apply-flow, anchor placement, empty-doc INSERT, heading-aware index,
  surgical OOXML diffing) is paused with the surface.
- **AUD-201/202 taskpane sign-in flow** — repurpose for the configuration
  UI at `app.audrey.xeqtor.com`.
- **Open PR `claude/fix-insert-empty-doc`** — leave open. Don't merge
  without smoke-testing; don't block on it. Will be archived once TCP
  Stage A is live and the taskpane is formally shelved.
- **Proofread agent design (Layers A/B/C)** — corollary of the taskpane
  apply flow. Paused. Anthropic's Word integration handles redline
  application; Audrey TCP just provides matter context via MCP.
- **Fallback-comments / clause-path-resolver work** — same reason. Paused.
- **ADNOC content-extraction investigation** — close out the immediate
  question (was content empty?) for completeness, then archive.

### What survives and gets repointed

- **Supabase schema** — extended, not replaced. New tables for positions,
  counterparty observations, events, client playbooks (per spec §4.2).
- **Embeddings pipeline** (3-small / 3-large) — reused as-is.
- **Microsoft OAuth via Azure / Supabase** — reused for configuration UI
  sign-in.
- **Outlook ingestion via Graph webhooks** (was planned for Audrey core)
  — promoted to a Stage B deliverable for TCP.
- **System prompt v3.0 work** — decomposed into per-skill prompts in the
  plugin's `skills/` directory.
- **Analytical depth work** (extended thinking, prompt design, chain-of-
  thought integration) — becomes the inside of MCP server reasoning
  guidance, not the taskpane's edit format.
- **Stripe billing scaffolding** — reused with a different pricing model
  (see commercial section below).

---

## Architecture summary

Four components:

1. **Audrey TCP plugin** — markdown + JSON repo modelled on Anthropic's
   `commercial-legal` plugin structure. Distributed via Cowork plugin
   marketplace and `claude.com/plugins`. No build step.
2. **Audrey MCP server** — hosted multi-tenant TypeScript service on
   Railway. Exposes typed tools (`get_matter`, `get_counterparty_history`,
   `get_client_playbook`, etc.). OAuth-authenticated via Supabase.
3. **Audrey data plane** — Supabase (Postgres + pgvector). Schema extended
   from current Audrey with matter-state, counterparty, position tables.
4. **Audrey configuration UI** — web app at `app.audrey.xeqtor.com`. Used
   for matter setup, ingestion review, counterparty profile curation,
   audit trail review. Not a Word add-in — a normal web app.

Request flow (worked example, NDA review):

1. GC opens NDA in Word with Claude for Microsoft 365 sidebar open.
   Both `commercial-legal` and `audrey-tcp` plugins installed.
2. GC asks Claude to *"review this against our position with this
   counterparty"*.
3. Claude's reasoning loop matches the request against `audrey-tcp`'s
   `matter-review` skill (semantic match on the skill description).
4. The skill instructs Claude to call Audrey MCP tools: `get_matter_by_
   document(hash)`, `get_counterparty_history(party_id)`,
   `get_client_playbook(client_id, 'nda')`.
5. Claude reasons over the document with this context loaded.
6. Anthropic's Word integration produces the tracked-change redline.
7. After GC accepts/rejects, an event is recorded back via
   `record_position` so matter state stays current.

Inference is **always** the user's Anthropic subscription. We never call
the Claude API. Our cost base scales with corpus and user count, not
query volume.

---

## Decisions made in the Sisi briefing

These supplement the spec.

### Privilege model — simplified by workspace selection

The current Audrey workspace-selection pattern is the privilege engine.
Once you select Client A's workspace, the entire session is RLS-scoped
to A's data — at the database layer, at the MCP tool layer, at the UI.
Cross-client leak is solved at the schema layer.

The MCP hook becomes light: *"current workspace matches the
authenticated user's selected workspace"*. Within a workspace, rules
needed (from Raj, as we hit each case):

- Whether matter-A observations can surface when working on matter-B
  for the same client
- How to handle common-interest matters (multiple clients on same side)
- Whether to tag documents/messages as "without prejudice" and treat
  differently

These get answered piece by piece as the implementation reaches them,
not up-front.

### Position extraction — kept, with scope discipline

The lightweight version (Audrey's current `save_matter_memory` from
chat) is in from Stage A. Manual add/edit of matter positions via the
configuration UI is in from Stage A. Tool `record_position(matter_id,
clause_type, value, source)` exposed from Stage A.

What's deferred to Stage C+: automatic extraction from redlined
documents, full state machine, concession tracking analytics.

### Repo — new

`audrey-tcp` repository, private to start, separate from current Audrey
repo. Reasons:

- Different lifecycle (Audrey core is archive, TCP is active build)
- Different stack profile (markdown plugin + TypeScript MCP +
  React config UI vs current Office.js + Vite + Node backend)
- Cleaner mental model for any future collaborator
- Allows future Apache 2.0 open-source of `plugin/` subdirectory
  independently of MCP server visibility

Shared infrastructure (Supabase, embeddings) doesn't live in either
repo — it's a deployed service both repos consume.

### Distribution wedge — individual first, team second

Mass distribution at low individual price point. Each individual builds
their own personal matter memory. When teams join, embeddings become
shared across team members via collaboration access tables. Pricing:

- **Individual tier:** £25–50/month, no friction signup
- **Team tier:** kicks in at second user invited to a matter, per-seat
  from there
- **Optional one-off ingestion service:** for individuals/teams who want
  hand-held loading of historical matters (the £2-5k figure in the
  spec is for this, not for self-serve)

Pricing tiers from the original spec (£6-15k annual platform fee) apply
at the firm-tier — when an organisation goes wall-to-wall.

### Compliance — ISO27001 + SOC2 awareness from day one

Build with the controls in place. Don't certify on day one (12+ months
process, no customers to certify for yet). Architecture decisions baked
in so retrofit isn't needed at month 18.

See "Compliance workstream" section below.

---

## Build stages

### Stage A — plugin + stub MCP server (2-3 weeks)

**Deliverables:**

- `audrey-tcp` repo scaffolded with plugin structure (`plugin/`,
  `mcp-server/`, `config-ui/`)
- Plugin manifest (`plugin.json`, `.mcp.json`, README)
- Three skills: `cold-start-interview`, `matter-review`,
  `counterparty-history`
- MCP server on Railway: TypeScript, OAuth via Supabase, stub
  implementations of `get_matter`, `get_matter_by_document`,
  `get_counterparty_history`, `get_client_playbook`. Returns real data
  from existing Audrey matter memory where available, stubs where the
  new schema isn't built yet.
- Minimal configuration UI: sign-in, create matter, upload document,
  view matter state. **Audit log already wired through.**
- `audit_log` table in schema v1 with append-only constraints
- RLS test suite asserting firm-isolation (CI-enforced)
- Branch protection + signed commits on `main`
- `SUBPROCESSORS.md` from commit 1
- Security page skeleton at `/security` in config UI
- Plugin installed and validated in Raj's Claude (Cowork / Claude for
  M365 / Claude Desktop — whichever install path works)

**Gate:** Raj runs a vendor agreement review in Cowork or Claude for
Microsoft 365 with Audrey TCP installed. Audrey returns matter context
that *visibly* changes the review output vs vanilla `commercial-legal`.
Demoable to either of the two waiting GCs.

### Stage B — real schema and ingestion (4-6 weeks)

**Deliverables:**

- Full matter schema migration: `positions`, `position_history`,
  `events`, `counterparty_observations`, `client_playbooks`
- Outlook ingestion via Microsoft Graph push webhooks. Email threads
  tagged by Client/Matter ingested as events.
- Document upload pipeline with version detection (draft N vs N+1) and
  clause-level chunking
- **Cross-document reference resolution at ingest:** when an Order Form
  is uploaded, detect references to the parent MSA already in memory and
  build the link automatically. Surfaces in UI as *"This Order Form
  references MSA executed 30 Jan 2026 — I've linked them."*
- `record_position`, `record_concession`, `record_event` tools (draft-
  and-approve via configuration UI review queue)
- Mass-upload ingestion flow: user uploads N related documents, system
  ingests in dependency order (MSA before Order Forms), surfaces the
  relationship map in the configuration UI

**Gate:** Audrey TCP ingests three completed matters end-to-end (term
sheet → execution). Counterparty profile for one repeat counterparty
shows useful intelligence vs starting from scratch.

### Stage C — pilot, billing, proof (4 weeks)

**Deliverables:**

- Pilot with one of the two waiting GCs: ingest 12-24 months of deal
  history. Populate client playbooks and counterparty observations from
  real material.
- Stripe billing integration: monthly subscription tiers (individual
  £25-50/month, team per-seat). Optional one-off ingestion service.
- Measurement: how often does Audrey-served context change AI output
  usefully? Track via configuration UI's review log.
- Plugin distribution decision: marketplace submission via
  `claude.com/plugins`, partner-built submission to
  `anthropics/claude-for-legal` under `external_plugins/audrey-matter-
  context/`, or both.

**Gate:** Pilot user articulates the lift over vanilla Claude for Legal
in concrete terms. Sufficient signal to begin paid onboarding of
GC #2.

---

## Compliance workstream (parallel to all stages)

Baked into Stage A architecture; documentation builds across A/B/C;
certification later when revenue justifies.

### Day-one architecture (Stage A)

- `firm_id` as tenancy boundary on every table; RLS-enforced; CI-tested
- `audit_log` table append-only from schema v1; 12-month minimum
  retention
- TLS everywhere (default); encrypted at rest (default with Supabase)
- Subprocessor list (`SUBPROCESSORS.md`) maintained from commit 1.
  Verified SOC2/equivalent for each: Supabase ✓, Anthropic ✓, OpenAI ✓,
  Railway (TBD), Microsoft Graph ✓, Stripe ✓.
- Branch protection on `main`, required PR review, signed commits
- MFA enforced on Supabase admin, Railway admin, GitHub org admin
- No production data on developer machines. Synthetic data only.

### Documentation (Stage B)

- DPA template (Raj writes / off-the-shelf adapted)
- Privacy policy + Terms of Service drafted before first paid user
- One-page incident response runbook
- Information security policy (one page initially, expanded later)
- Trust / Security page at `/security` populated honestly with current
  posture

### Certification (post-Stage C)

Vanta/Drata-style tooling is **not** a day-one cost. It's a productivity
multiplier for compliance work, not a requirement *for* compliance work.
Engage it when we're approaching the first audit — not before.

| When | What | Cost (approx) |
|---|---|---|
| Months 1-3 (Stage A & B) | Architecture only. No tooling spend. | $0 |
| Stage C, approaching first paid pilot | Engage Vanta or Drata (~$500-1500/mo). They'll wire up to existing controls. | $500-1500/mo |
| Months 3-6 | SOC2 Type 1 audit. | $8-15k one-off |
| Months 6-12 | SOC2 Type 2 evidence collection (6 months). ISO27001 if Europe-focused. | $15-25k annual |
| Months 12-18 | Both certifications live. Enterprise-ready. | $30-50k/year ongoing |

Total ongoing compliance cost ~$30-50k/year once certified. Factor
into financial plan; not into build timeline.

### Tenancy model — multi-tenant default, dedicated-instance ready

Architecture supports both from day one; only multi-tenant implemented
in Stage A.

**Multi-tenant (default):**
- Single Supabase project. `firm_id` on every table. RLS-enforced.
- Workspace selection (current Audrey pattern) is the privilege engine.
- Cheaper to operate, one schema migration runs everywhere.
- Serves individuals, teams, most mid-size firms.

**Dedicated instance (built on demand):**
- Each firm gets own Supabase project (or own DB within shared Supabase
  org). MCP server routes per authenticated firm.
- Required by: large firms with audit walls, jurisdictional data
  residency mandates (e.g. EU-only storage), firms whose risk function
  won't accept shared-tenant.
- More expensive to operate. Premium pricing tier above firm-wide.

**Day-one discipline that makes the upgrade path cheap:**

> The MCP server **never queries Supabase directly** from a tool
> implementation. Every database access goes through a repository layer
> that takes `firm_id` as a parameter. The repository layer is the only
> place that decides whether to route to the shared DB or a dedicated
> instance.

This is a coding standard, not a feature deferral. Cost is ~zero on day
one. When the first dedicated-instance customer arrives, the upgrade is a
single layer change, not a refactor across every tool.

### Existing data migration

The TCP MCP server shares the existing Audrey Supabase instance (per
spec §3.1). Migration is in-place, not lift-and-shift to a new database.

**Carries over directly (no transformation):**
- Clients, matters (with new columns: `stage`, `privilege_scope`)
- Documents, document chunks, embeddings
- Client playbooks
- Auth / users (Raj's account survives the pivot)

**Needs transformation:**
- `matter_memory` entries → become `events` rows in new schema. Each
  memory entry maps to one event with original timestamp preserved.
- Migration script renames old table `_legacy_matter_memory` (not
  dropped) for 30-day safety window.

**Skipped:**
- Chat session history (noise; value already extracted into matter
  memory)

**Approach:**
1. **Stage A:** New tables added alongside existing schema. MCP server
   reads from both old and new where applicable.
2. **Stage B:** Migration script runs once. Old `matter_memory` table
   renamed for safety.
3. **Stage A also:** Raj's existing data becomes the dogfood test case.
   Migration is validated against his own account before any pilot
   client touches it.

---

## Open questions and decisions

From spec §10, with current status:

1. **First pilot client** — ✅ resolved. Two GCs waiting from Raj's
   network. Pick one for Stage C; second follows.
2. **Pricing tier values** — pending. Spec range £2-5k setup / £6-15k
   annual reframed: individual £25-50/month, team per-seat, one-off
   ingestion service £2-5k optional. Test during Stage C.
3. **Jurisdiction focus** — pending. UK first. US-readiness deferred
   unless pilot client demands it.
4. **Open-source posture for plugin** — pending. Recommendation: Apache
   2.0 on `plugin/` subdirectory only; MCP server proprietary. Decide
   end of Stage A when we know what's worth open-sourcing.
5. **Distribution path** — pending. Self-publish to `claude.com/
   plugins` is the default; partner-built submission to Anthropic's
   `claude-for-legal` repo is upside. Decide end of Stage B.
6. **Plugin slash command naming** — pending. `/audrey:matter-review`
   is the working pattern. A/B during Stage C with pilot user.

---

## Immediate next moves

1. **Save this doc** to current Audrey repo as preserved context across
   sessions — done by creating this file.
2. **Raj creates `audrey-tcp` GitHub repo** — private to start. Sisi
   can't create a new repo from the dev sandbox.
3. **Sisi scaffolds plugin + MCP server locally** once repo URL is
   available. Hello-world plugin + one stub tool returning hardcoded
   data + minimal MCP server.
4. **Raj installs the hello-world plugin** into Claude (Cowork / Claude
   for M365 / Claude Desktop) using a runbook Sisi provides. ~20 min.
   This is the day-one spike that determines whether the Stage A demo
   path needs adjusting.
5. **Pause `claude/fix-insert-empty-doc` PR** with a comment noting the
   strategic pivot.
6. **Raj schedules a 30-min call** with one of the two waiting GCs.
   Walk through the cold-start interview at concept level. Listen, not
   sell. Capture reactions for skill design.

Once those land, Stage A begins in earnest.

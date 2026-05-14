# Config UI

Web app at `app.audrey.xeqtor.com`. Handles:

- Matter setup (create, edit, archive)
- Document upload (drag-and-drop, batch upload)
- Cross-document reference review (e.g. *"This Order Form references
  MSA executed 30 Jan 2026 — link confirmed?"*)
- Ingestion review queue (approve/reject AI-proposed position
  updates)
- Counterparty profile curation
- Audit trail review
- Workspace settings (client/matter scoping, MFA, subscription)

## Stage A status

Placeholder. The Stage A demo can work via direct MCP tool calls and
hand-curated Supabase data — the config UI is not strictly needed for
the day-one install spike.

## Stack (when built)

- React + Vite (matches existing `context-app` so future shared
  component extraction is plausible)
- Supabase Auth for sign-in
- Tailwind for styling
- React Query for API state

## Implementation plan

Stage A: skeleton — sign-in, list matters, view one matter. ~3-4 days.
Stage B: full ingestion review queue, audit trail, counterparty
  profiles. ~2 weeks.
Stage C: subscription / billing surfaces. ~1 week.

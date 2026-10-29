# Granola integration: meetings flow into the right client automatically

**Status:** proposal for Raj's sign-off (merging this PR = sign-off) · **Date:** 2026-10-29 · **Author:** Sisi
**Depends on:** the document-ingestion pipeline (spec #60: migration 017 + PRs audrey-tcp#62 and legacy #21) being live.
**Raj's plan:** Granola Business — folders, full history and transcripts are available through MCP.

---

## 1. Goal

When Raj finishes a client meeting recorded in Granola, the meeting — transcript, Granola's summary, Raj's own notes and the attendee list — lands in Audrey under the right client or matter without any manual step. Once there it is searchable, its negotiation positions are extracted, and anything decided in the meeting appears as a **proposed** decision card. A meeting can propose; only Raj settles (Matter Memory spec §2).

## 2. What Granola provides (verified 2026-10-29)

- **Official MCP server** at `https://mcp.granola.ai/mcp`. Tools: `list_meeting_folders`, `list_meetings` (filterable by folder), `get_meetings` (attendees, private notes, summary), `get_meeting_transcript`, `get_meeting_attachment` (shared-screen images), `get_account_info`, `query_granola_meetings`, `switch_workspace`, `sign_out`. Folders and transcripts are paid-plan features (Raj has them).
- **Scope:** only notes the user owns or that were shared with them individually; not notes that live only in a team folder.
- **Rate limit:** about 100 requests per minute across tools.
- **Authentication supports a server-side connection.** The authorisation server (`https://mcp-auth.granola.ai`) publishes dynamic client registration, PKCE authorisation-code flow, refresh tokens and the `offline_access` scope. Audrey's backend can therefore register itself, have the user approve once in the browser, and then poll in the background.
- **No public REST API or native webhooks.** The only official push route is Zapier ("Note added to Granola folder"), which this spec deliberately does not use (§8).
- **Unknowns to settle in step G0:** exact tool input parameters (the docs don't list them; `tools/list` will), whether `list_meetings` takes a date filter, and the transcript's speaker labelling.

## 3. Design overview

```
Granola  ──(MCP over HTTPS, user's OAuth token)──►  Audrey backend sync job (every 15 min)
                                                        │
                       folder mapped? ──yes──► ingest as meeting document ─► passages + positions
                              │                         └─► capture pass ─► PROPOSED decisions / notes
                              no
                              └──► "To file" list (with a suggested client) ─► Raj files or ignores
```

The integration lives in the **legacy backend**, next to the ingestion service it feeds (`backend/src/integrations/granola/`). Configuration and the "To file" list live in **Context Capture** (the desktop configuration app). Meeting documents then appear everywhere documents already appear (pane Matter tab, chat context, connector search).

## 4. Connecting (one-time per user)

1. **Client registration:** on first use the backend registers Audrey with Granola's authorisation server (dynamic client registration), redirect URI `https://api.audrey.xeqtor.com/api/integrations/granola/callback`. The returned client ID is stored server-side and reused.
2. **Connect button** (Context Capture → Integrations → Granola): starts the PKCE authorisation-code flow with scopes `openid email offline_access`. The user approves in Granola's page.
3. **Callback:** the backend exchanges the code, stores the **refresh token encrypted** (AES-256-GCM, key in Railway env `GRANOLA_TOKEN_KEY`), records the Granola account email and active workspace (`get_account_info`), and shows "Connected as …".
4. **Disconnect:** calls Granola's `sign_out`, deletes the stored token, keeps already-ingested meetings.

**Hard rule:** Audrey never calls `switch_workspace` — it changes the user's active workspace in the Granola app and every other connected tool. If the active workspace isn't the one Raj chose at connect time, sync pauses and Context Capture shows "Granola is set to a different workspace."

## 5. Mapping folders to clients and matters

- Context Capture lists the user's Granola folders (`list_meeting_folders`: title, description, note count) beside a dropdown of Audrey clients and matters.
- Each folder maps to **one client (client-wide) or one matter**, or is marked **ignore**. Default for a new folder: unmapped.
- Convention we recommend: one Granola folder per client or matter, named the same as in Audrey. The UI pre-selects an exact or near name match for one-click confirmation; it never maps silently.

## 6. Sync

Runs every 15 minutes per active connection (in-process timer, same pattern as the TCP keep-alive tick), plus a "Sync now" button.

1. Refresh the access token if needed (refresh-token grant). A refresh failure marks the connection "needs reconnecting" and stops; nothing is retried in a loop.
2. **Mapped folders:** `list_meetings` per mapped folder; skip meeting IDs already recorded.
3. **Unmapped meetings:** `list_meetings` across the account for the last 14 days; anything not in a mapped or ignored folder goes to the **To-file list** (§7).
4. **Readiness:** ingest a meeting only once Granola has finished it — summary present and the meeting ended at least 20 minutes ago — so we don't capture a half-processed note. Not ready → try again next run.
5. **Fetch:** `get_meetings` (title, date, attendees, Raj's notes, summary) and `get_meeting_transcript`.
6. **Build the document** (Markdown, through the ingestion pipeline as a text original, `conversion_method = 'granola'`, `document_role = 'meeting'`):
   - Name: `Meeting – <title> – <YYYY-MM-DD>`
   - Header: date, attendees (name, email), Granola share link
   - Sections: Summary (Granola's), My notes (Raj's private notes), Transcript (with speaker labels as Granola provides them)
   - Shared-screen images are not fetched in v1.
7. **After ingest:** the existing pipeline queues extraction (passages + positions). Then a **capture pass** runs over the meeting (§9).
8. Every step is idempotent, keyed on the Granola meeting ID. A failure on one meeting is recorded and retried next run (max 5 attempts, then shown as failed in Context Capture).

**Budget:** a typical run is a handful of calls; even a backfill of 200 meetings is ~400–600 calls, paced under 60 per minute.

## 7. The "To file" list

Meetings Granola has but no mapped folder covers. Each row shows title, date, attendees and a **suggested** client or matter:
1. attendees' email domains that already appear on filed meetings for exactly one client;
2. the client or matter name appearing in the meeting title;
3. otherwise no suggestion.

Actions: **File** (choose client/matter → ingested immediately), **Ignore**, or **Map this folder** (if it is in an unmapped folder). Nothing is filed without Raj's click. Optionally (decision §12.4), later, high-confidence suggestions could auto-file.

**Backfill on first connect:** Context Capture offers "Import past meetings from mapped folders" with a date picker; off by default.

## 8. Why not Zapier

Zapier's "Note added to folder" trigger would work for one user, but it adds a third party that receives full client-meeting transcripts (a subprocessor a law firm's IT will question), needs a Zapier account and a Zap per folder per user, and only fires from the desktop app. The direct connection keeps transcripts flowing Granola → Audrey only, and each pilot user just clicks Connect. Zapier remains a fallback if Granola's terms (§11) rule out server-side MCP use.

## 9. Capture from meetings (proposals only)

- Reuses the S2c post-turn capture (decision detection + working-record notes) with a meeting-specific instruction: only commitments made **by our side** become proposed decisions; the other side's statements become working-record notes ("Counterparty said…"). Granola's speaker labels (the user's microphone vs other participants) are the primary signal; where unclear, the capture defaults to a note, not a decision.
- Proposals carry provenance: `source_tool = 'granola'`, the Granola meeting ID and the timestamp/passage they came from. Cards read "Captured from Granola meeting, <date>".
- Cap: at most 3 proposed decisions and 8 notes per meeting.
- Never settles anything (enforced by the existing database constraint).

## 10. Data model (one migration, Raj runs it)

All tables firm-stamped, RLS on with no anon/authenticated policies (service-role only), matching migrations 014/019.

| Table | Purpose |
|---|---|
| `integration_connections` | provider ('granola'), firm_id, user_id, account email, workspace id, encrypted refresh token, token expiry, status (active / needs_reconnect / paused / disconnected), last_sync_at, last_error |
| `granola_folder_mappings` | connection_id, granola_folder_id, folder title, target client_id **or** matter_id **or** ignore |
| `granola_meetings` | connection_id, granola_meeting_id (unique per connection), title, meeting date, attendees, folder id, status (pending / ingested / to_file / ignored / failed), attempts, document_id, suggested client/matter, error |

App-level config (registered client ID) lives in a small `integration_settings` row.

## 11. Security, confidentiality and terms

- **Least data:** Audrey reads only what it ingests; no `query_granola_meetings` free-text queries from the server.
- **Token storage:** refresh tokens encrypted at rest; the key is separate from the database. (Lesson of the October Railway incident: the key lives in Railway env, so a combined env + database breach would still expose tokens — rotate `GRANOLA_TOKEN_KEY` and force reconnects in any future incident; documented in the support runbook.)
- **Transcripts are confidential client material** and contain third parties' personal data. They inherit Audrey's document protections (private storage, firm scoping, sign-in enforcement). Deleting a meeting in Audrey deletes its document, passages and pending proposals; it does not touch Granola.
- **Recording consent** remains the user's responsibility in Granola; Audrey adds nothing to it.
- **Raj to check:** Granola's terms for server-side use of the MCP server by a third-party application (it is marketed for "AI tools", which Audrey is). If the terms prohibit it, fall back to §8.

## 12. Decisions for Raj (sign-off checklist)

1. **Direct MCP connection** rather than Zapier. Recommended: yes.
2. **Mapping by Granola folder**, unmapped meetings to a To-file list, nothing filed without a click. Recommended: yes.
3. **Content ingested:** summary + your private notes + full transcript; no shared-screen images in v1. Recommended: yes.
4. **Auto-filing of high-confidence suggestions:** not in v1; revisit after a month of real use. Recommended: not yet.
5. **Meeting capture** proposes decisions (our side only) and notes. Recommended: yes.
6. **Backfill** of past meetings offered but off by default. Recommended: yes.

## 13. Delivery

| Step | Content | Estimate |
|---|---|---|
| G0 | Spike with Raj's account: register, connect, `tools/list`, confirm parameters, transcript format, speaker labels, readiness signal | 0.5 day |
| G1 | Migration + token encryption + connect/disconnect/callback routes | 0.5 day |
| G2 | MCP client + sync job (mapped folders, readiness, idempotency, budget) → ingestion | 0.5 day |
| G3 | Context Capture: Integrations page, folder mapping, To-file list, Sync now, backfill | 0.5 day |
| G4 | Meeting capture pass (proposals with provenance) | 0.25 day |
| G5 | End-to-end test on real meetings; support runbook update | 0.25 day |
| | **Total** | **~2.5 days** |

**Acceptance:** a new meeting filed in a mapped Granola folder appears in the right Audrey client/matter within 30 minutes with transcript, summary and attendees; passages are labelled and searchable; decisions spoken by Raj appear as proposed cards with "Captured from Granola meeting"; an unmapped meeting appears in To-file with a sensible suggestion; disconnect revokes and stops sync; re-running sync never duplicates a meeting.

Sequencing: after the ingestion pipeline is live; before Stage 2e.

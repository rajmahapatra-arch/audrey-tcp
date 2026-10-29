# Granola MCP: tool schemas (discovered 2026-10-29)

These schemas come from `tools/list` on `https://mcp.granola.ai/mcp` (Business plan). They cover input parameters only. No meeting content is recorded here. Parameters marked `?` are optional. `node src/cli.js connect` saves the full JSON schemas to `%LOCALAPPDATA%\granola-filer\tools-schema.json`.

## Tools Granola Filer calls (read-only allow-list in `src/granola.js`)

| Tool | Parameters |
|---|---|
| `get_account_info` | (none) |
| `list_meeting_folders` | `limit?` int (max 100), `offset?` int |
| `list_meetings` | `time_range?` enum `last_7_days, this_week, last_week, last_30_days, custom`; `from_date?`, `to_date?` (ISO date, offsetless = user's timezone); aliases `custom_start?`, `start_date?`, `custom_end?`, `end_date?`; `limit?` int (cap 200 on paid plans); `cursor?` string (≤2048); `updated_after?`; `folder_id?`; `workspace_only?` bool; `involvement?` {`captured_by_me?`, `listed_as_participant?`}; `max_participants?` int |
| `get_meetings` | `meeting_ids?` string[] (max 10); `note_ids?` string[] (alias); `max_participants?` int; `attachments?` enum `list, count, none` |
| `get_meeting_transcript` | `meeting_id?` / `note_id?` string; `meeting_ids?` string[] (max 10); `offset?` int; `max_chars?` int (≥1000, default 40000, cap 80000); `include_timestamps?` bool; `offsets?` {id: int} |

## Tools present but never called

The client refuses to call any of these (unit-tested):

| Tool | Parameters | Why not |
|---|---|---|
| `query_granola_meetings` | `query` string; `document_ids?` / `note_ids?` string[] (max 10) | Instructed never to call it |
| `sign_out` | (none) | Would sign Raj out |
| `search_meetings` | Date params as for `list_meetings`, plus `keywords?` string[], `participant?`, `attended_only?`, `include_shared?`, `folder_id?`, `cursor?`, `limit?` (cap 100), `updated_after?` | Not needed |
| `get_meeting_attachment` | `meeting_id?` / `note_id?`, `attachment_id?`, `attachment_ids?` (max 5), `offset?`, `limit?` (max 5) | Not needed |
| `add_note_to_folder` | `note_id`, `folder_id` | Write tool |
| `remove_note_from_folder` | `note_id`, `folder_id` | Write tool |
| `create_folder` | `title`, `description?`, `visibility?` enum `private, workspace` | Write tool |
| `update_folder` | `folder_id`, `title?`, `description?` | Write tool |
| `list_templates` | (none) | Not needed |
| `generate_summary` | `meeting_id?` / `note_id?`, `template_id?` | Write tool |
| `update_private_notes` | `meeting_id?` / `note_id?`, `operations` [{`op` append/prepend, `text`}] | Write tool |
| `give_feedback` | `message`, `category?`, `tool_name?`, `severity?` | Not needed |

`switch_workspace` was **not** in the tool list on 2026-10-29. It is on the block-list anyway.

## Response formats (structure only)

- `list_meeting_folders` returns JSON: `{count, folders: [{id, title, visibility, audience, parent_folder_id, role, description, note_count}]}`.
- `list_meetings` and `get_meetings` return tagged text:
  - The wrapper is `<meetings_data …>` containing `<meeting id title date meeting_at url …>` elements.
  - Each meeting holds `<known_participants>` as free text, in the form `Name (note creator) from Company (email), …`, and `<folders>` with `<folder id title …/>`.
  - `get_meetings` also returns `created_at`, `updated_at`, `<private_notes status=…>` and `<summary>` (markdown).
  - Paging is a trailing `<pagination has_more … />` element.
- `get_meeting_transcript` returns JSON: `{id, title, created_at, meeting_at, recording_context, truncated, offset, total_chars, transcript}`. The `transcript` field is speaker-labelled text, paged by `next_offset`.
- There is **no end time**. Readiness uses `updated_at` as a proxy, falling back to start + 60 minutes.

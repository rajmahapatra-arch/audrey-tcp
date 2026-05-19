# Markup spike — findings and decision

**Status:** Closed. Verdict reached on 2026-05-19 from empirical Claude
for Word session.

## The question

Could a custom MCP connector (e.g. `word-mcp-live`, `docx-mcp`)
deliver better surgical-edit quality than Claude for Word's native
apply layer, which was observed to collapse small surgical edits into
block-style tracked changes?

## What we tested

Two builds:

1. Both candidate MCPs installed locally and exposed via `cloudflared`
   quick tunnel as a Claude.ai custom connector (`word-live-tunnel`).
   Registered, connected, visible in Claude for Word's `+` menu.
2. Real markup task driven from inside Claude for Word against a live
   matter document (SOW 2026.002 Amendment 1).

## What we observed

### Finding 1 — Claude for Word ignores registered MCPs for edits

Claude for Word's **Apply** button is hard-wired to Office.js. Custom
MCP connectors are visible in the connector list and their tools are
loadable, but **the Apply path does not route through them**. Confirmed
explicitly by the model: *"Apply on a card and `edit_doc_text` both
write through the Word add-in (Office.js) — neither uses
`word-live-tunnel`."*

A custom HTTP MCP can still be invoked for *read-side* tasks (analysis,
document search, comment generation) but it cannot replace the
write layer. Option 2 (HTTP-expose) is therefore inert for the
specific problem of fixing markup quality.

### Finding 2 — the problem is prompting, not architecture

The "block replacement" behaviour observed yesterday was not a bug in
Office.js or in Claude for Word's apply layer. It was an artefact of
Claude's default `old_text` width when proposing edits via
`propose_doc_edits` or `edit_doc_text`.

In the live test, the first attempt at "tighten this sentence" emitted
a single 28-word `old_text` containing 4 changing words and 24 words
of unchanged context. Apply faithfully implemented that as a 28-word
delete + 28-word insert → block redline.

When the model was explicitly asked to re-emit as tight surgical edits
with minimum-span anchors, it produced three tracked changes covering
only the words that actually changed:

| `old_text` | `new_text` |
|---|---|
| `being onboarded as a customer` | `becoming a customer` |
| `Integrated Solution but the deliverables` | `Integrated Solution. The deliverables` |
| `are not conditional` | `are not, however, conditional` |

These landed surgically. Word displayed them as the senior-lawyer-style
mark-up the user was looking for.

### Finding 3 — Claude for Word has rich built-in tools we didn't know about

The session surfaced tools we hadn't documented previously:

- `search_doc_text` — body search
- `read_doc_section` — paragraph range read
- `propose_doc_edits` — staged edit cards
- `edit_doc_text` — direct write
- `get_document_info`, `get_properties`
- `refresh_mcp_connectors` (server-tool)
- `context_snip` (internal context management)

These are sufficient for high-quality markup workflows *if* used with
discipline.

## Decision

**Resolved by adding surgical-edit discipline to the plugin
`CLAUDE.md`.** No custom Word add-in build, no MCP integration for the
write path. The 50-line addition to `.claude-plugin/CLAUDE.md`
(committed on `feat/document-handoff`) instructs Claude:

- Always emit minimal-span `old_text`
- Never include unchanged sentences as "context"
- Multiple changes → multiple separate edits
- Sentence-boundary changes → split into two
- Hard rule: `old_text` > 10 words with only 1–3 words changing →
  re-emit as multiple tight edits

This costs us nothing in the strategic frame: the pivot premise
(Claude for Word + Audrey context delivered via MCP) holds. The
markup-quality fix is plugin-side, not infrastructure-side.

## What gets kept / killed

| Asset | Disposition |
|---|---|
| `C:/dev/word-mcp-live/` | Keep cloned. Future use as a *local agent* for ingestion / batch workflows (per Raj's bookmarking). Not deployed. |
| `C:/dev/docx-mcp/` | Keep cloned. Same reason — useful capability set for future Audrey-side workflows. |
| Cloudflared tunnel + `word-mcp-live` HTTP server | Torn down on conclusion of the test. |
| `word-live-tunnel` connector in Claude.ai | Should be removed (Raj's hands — settings → connectors → delete). |
| `feat/markup-spike` branch | Closing now; merge-or-discard at Raj's discretion. Setup notes preserve install gotchas for future machine setups. |
| `feat/document-handoff` branch | Carries the actual deliverable: plugin discipline + document-memory feature. |

## Net cost of the spike

- ~6 hours across two days. Of those, ~3 hours were install-thorn
  debugging (Python/uv setup, transport mismatch, DNS propagation,
  Rust-wheel issue on Python 3.14, uv link bug, etc.)
- Outputs: three captured install gotchas (in `README.md`), validated
  cross-surface MCP availability, validated the actual failure mode
  is prompting not architecture, two new MCPs installed and ready for
  future use.
- Net: spike value is **strongly positive** despite the cost. We
  avoided spending weeks building an unnecessary Word add-in. The
  pivot architecture is now validated end-to-end including the
  markup story.

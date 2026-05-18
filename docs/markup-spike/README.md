# Markup MCP spike — sitting 1 setup notes

**Goal:** decide whether Audrey's Word markup story should be (a) ride Claude
for Word's default mechanics, (b) integrate one of the open-source markup
MCP servers, or (c) lift the legacy taskpane's surgical-OOXML engine into a
new `audrey-markup-mcp`. Empirical comparison on a real Audrey matter
document is the deciding input.

This directory captures sitting 1 of the spike: the two MCPs under test,
how to install them, the test spec for sitting 2, and (eventually) the
findings from sitting 3.

## The two candidates

Both cloned to `C:/dev/`. **Skip GongRzhe's Office-Word-MCP-Server** for
now — `word-mcp-live` is built on top of it, so testing the parent is
redundant.

### `word-mcp-live` (ykarapazar)

- Clone: `C:/dev/word-mcp-live/`
- Tools: **115** total, split into 80 cross-platform + 44 Windows-live
  (some macOS-live since v1.5.0 via JXA)
- Architecture: **Two modes.** Cross-platform mode uses python-docx on
  closed `.docx` files. Live mode uses Windows COM (`pywin32`) — talks to
  an already-open Word process. The model picks the right mode per task.
- Tracked changes: native Word revisions, author name set via
  `MCP_AUTHOR` env var. Per-action Ctrl+Z on Windows live.
- Comments: threaded — add, reply, resolve, delete.
- License: MIT. Privacy: 100% local, no telemetry.
- Built on top of GongRzhe/Office-Word-MCP-Server, so inherits that
  surface plus the live mode.

### `docx-mcp` (SecurityRonin)

- Clone: `C:/dev/docx-mcp/`
- Tools: **45**, file-only (no live mode).
- Architecture: **File-based.** Unzips the .docx archive, parses XML
  parts with lxml, edits the cached DOM, repacks. Validates against
  OOXML spec before saving — catches the silent "Word repaired this
  file" rewrite failure mode.
- Tracked changes: real `w:ins` / `w:del` runs with revision marks.
- Comments: paragraph-anchored, threaded replies supported.
- Companion skill: ships with a Claude skill at
  `C:/dev/docx-mcp/docx_mcp/skill/SKILL.md` that auto-installs on first
  server run and teaches Claude the OOXML editing workflow. Worth a
  read on its own — the prompt design itself is informative.
- Unique: structural audit (`audit_document`), paraId uniqueness
  validation, watermark removal.
- License: MIT.

## Architectural philosophies — pick your bet

| Dimension | `word-mcp-live` | `docx-mcp` |
|---|---|---|
| **Edit cycle** | Live — Word stays open, changes appear instantly | Batch — open file → edit → save → reopen in Word |
| **Tool surface** | Large (115). Surface area risk: model might be overwhelmed | Curated (45). Focused on the editing primitives that matter |
| **Validation** | Relies on Word/COM to maintain document integrity | Explicit OOXML validation before save (catches silent corruption) |
| **Platform** | Windows + macOS live; cross-platform for file mode | Cross-platform (any OS with Python 3.10+) |
| **Best fit for** | Interactive sidebar UX (lawyer watches edits land) | Server-side pipeline ("send me the doc, get redlines back") |
| **Risk** | COM bridge fragility on Windows; macOS feature gaps | Slower iteration loop; no live undo |

For Audrey's pivot architecture (lawyer in Word with Claude for Word
sidebar making real-time markups), `word-mcp-live` is closer to the
target UX. But `docx-mcp`'s validation discipline and tool curation
suggest a more rigorous engineering culture — worth seeing how that
manifests in actual edit quality.

## Required setup before sitting 2

**Both MCPs need Python 3.11+ installed.** This machine currently has
no real Python (only the Windows Store stub). Sitting 2 starts with:

1. Install Python 3.11+ from [python.org](https://www.python.org/downloads/)
   — pick "Add Python to PATH" during the installer wizard.
2. Install `uv` (the fast Python package manager that provides `uvx`):
   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```
3. Verify: `uvx --version` should print a version number.

Estimated time: 5–10 minutes.

After Python + uv are installed, the MCP servers themselves install
on first invocation via `uvx <package>` — no separate install step.

## Claude Desktop configuration

The current `claude_desktop_config.json` has Audrey wired in. Add
both markup MCPs alongside Audrey by replacing the `mcpServers`
block.

**Config file location depends on how Claude Desktop was installed:**

- **Microsoft Store install (Raj's machine):**
  `C:\Users\rajma\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
  The Store sandbox redirects what the app *thinks* is
  `AppData\Roaming\Claude\` into a Package-isolated path. The
  standard documented location doesn't exist as a normal file.
  Quickest way to open: `notepad C:\Users\rajma\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
  from a Run dialog (Win+R).

- **Standalone install (most public docs):**
  `%APPDATA%\Claude\claude_desktop_config.json`
  i.e. `C:\Users\<you>\AppData\Roaming\Claude\…`

The block to replace `mcpServers` with:

```json
{
  "mcpServers": {
    "audrey": {
      "command": "node",
      "args": [
        "C:/dev/audrey-tcp/mcp-server/dist/stdio.js"
      ]
    },
    "word-live": {
      "command": "C:\\Users\\rajma\\.local\\bin\\uvx.exe",
      "args": ["--from", "word-mcp-live", "word_mcp_server"],
      "env": {
        "MCP_AUTHOR": "Raj Mahapatra",
        "MCP_AUTHOR_INITIALS": "RM"
      }
    },
    "docx-mcp": {
      "command": "C:\\Users\\rajma\\.local\\bin\\uvx.exe",
      "args": ["--python", "3.12", "docx-mcp-server"]
    }
  }
}
```

Then restart Claude Desktop. Both servers should appear under
"connected" in the MCP indicator at the bottom of the chat window.

**Three known gotchas encountered during sitting 1, all worked around
above — leaving notes here for future installs:**

1. **Microsoft Store Claude Desktop sandboxes PATH.** Generic `"uvx"`
   in args fails because the Store sandbox doesn't inherit
   `%USERPROFILE%\.local\bin`. Fix: absolute path to `uvx.exe`. If
   you have the standalone Claude Desktop install, plain `"uvx"`
   usually works.

2. **word-mcp-live README has wrong entry-point.** The README says
   `uvx word-mcp-live` but the actual binary inside the package is
   `word_mcp_server`. Correct invocation:
   `uvx --from word-mcp-live word_mcp_server`. `uvx` itself prints
   this hint when it fails — useful debug.

3. **docx-mcp-server transitively needs Rust on Python 3.14.** It
   pulls in `spacy-transformers` → `spacy-alignments`; the latter
   doesn't ship pre-built wheels for Python 3.14 yet (released
   late 2025), so `uv` tries to compile from source and fails for
   lack of Rust. Workaround: `uvx --python 3.12` pins to a Python
   version with available wheels. `uv` will install 3.12
   automatically the first time (~30 MB). Python 3.14 stays as the
   system default for everything else.

   Alternative if 3.12 still fails: install Rust via
   `https://rustup.rs/` (~600 MB) and let `uv` build from source.

## The test spec — sitting 2

Picking the **task** matters more than picking the **document**. We
want a revision that exercises three different mechanics:

1. **Single-word replace, multiple instances** — tests basic
   search-replace discipline. Does it land as N individual tracked
   changes or one block?
2. **Targeted insert mid-clause** — tests anchored insertion. Does it
   put the new text exactly where asked, or rewrite the surrounding
   sentence?
3. **Clause-level structural edit** — tests larger semantic rewrites.
   Does it surgically modify the changed parts, or replace the entire
   clause as one giant block?

### Proposed task

> Open `<your-test-matter>.docx` and:
>
> 1. Replace every instance of "commercially reasonable" with
>    "reasonable" in sections 3–5 only. Track every replacement.
> 2. In the indemnity clause, add a carve-out for IP infringement —
>    insert the sentence "The foregoing indemnity does not apply to
>    claims arising from IP infringement caused by Counterparty's
>    pre-existing materials." after the existing exclusions list.
> 3. Tighten the liability cap to "12 months of fees paid in the
>    12-month period preceding the claim" — currently reads "amounts
>    paid under this Agreement". This is the structural rewrite.
> 4. Add a comment on the new IP carve-out explaining "Per AcmeCo
>    standard position — see settled positions in Audrey for matter
>    [name]."

The three sub-tasks deliberately escalate from mechanical (1) to
semantic (3). The instrument we measure most carefully is task 3 —
this is where Claude for Word currently fails, per your direct
observation.

### Document choice

Pick something real but **not load-bearing** — a matter where you
have a baseline expectation of what a clean markup looks like, but
not something a counterparty is waiting on. The KBR Innovation
Studio matter or one of the Mission Zero NDAs from your matter list
would be reasonable candidates.

### Method

Run the same task three times against the same starting document.
Save each output as:

- `markup-spike-A-claude-default.docx`
- `markup-spike-B-word-mcp-live.docx`
- `markup-spike-C-docx-mcp.docx`

For each run:

- **A (Claude for Word default):** open Word with the doc, use the
  Claude sidebar, type the task verbatim. No Audrey, no markup MCPs
  in scope.
- **B (word-mcp-live via Claude Desktop):** open Word with the doc,
  open Claude Desktop, type the task verbatim. The MCP server is
  configured; Claude Desktop has access to both Audrey and word-live.
- **C (docx-mcp via Claude Desktop):** close Word. Open Claude
  Desktop, type the task with the full file path. The server edits
  the file, you reopen it in Word to see results.

If word-mcp-live's live mode misbehaves, fall back to its
cross-platform mode (file-based, same as docx-mcp's pattern) and
note the gap.

### Measurement axes

For each output, record:

| Axis | Question | Capture |
|---|---|---|
| **Granularity** | How many discrete tracked changes? Are they word-level or block-level? | Count + screenshot of revision pane |
| **Anchor accuracy** | Did edits land in the right place, or drift to nearby paragraphs? | Eyeball + flag any drift |
| **Author attribution** | Do tracked changes show as your name, or "Claude" / "AI"? | One line per output |
| **Comment fidelity** | Did anchored comments stay anchored to the new text, or float to paragraph level? | Eyeball + screenshot |
| **Section scoping** | Did the §§3–5 restriction get respected? Any leakage into §1–2 or §6+? | Confirmed / not confirmed |
| **Undo behaviour** | Can you undo the whole markup with one Ctrl+Z? Per-edit? Or not at all? | Test in Word after each output |
| **Workflow friction** | Anything weird — long latency, errors mid-run, model confusion about which tool to use? | Free-form notes |

Don't try to grade subjectively in the moment. Just capture the data
and the .docx files. Sitting 3 (analysis) is where I synthesise.

## What we'll know at the end

Three exits from this spike, each leading to a different next step:

1. **One MCP is clearly better than Claude for Word's default.** Decision:
   integrate. Stage A timeline adds the integration work as an explicit
   line item.
2. **Both MCPs are roughly equivalent to default — i.e. mediocre.** Decision:
   resurrect the legacy taskpane's surgical OOXML engine into a new
   `audrey-markup-mcp` MCP server. This is the largest piece of new work
   but matches the engineering quality the GC pilot will need.
3. **Default Claude for Word is genuinely fine.** Decision: park this
   thread, focus on context + ingestion, revisit if pilot feedback
   surfaces the markup gap as urgent.

Most likely: outcome 1 or 2. Outcome 3 seems unlikely given your direct
observation of block-replacement behaviour in default Claude for Word
and Harvey's published evidence of a real ceiling.

## Open questions / decisions for Raj

Before sitting 2 starts, three things you might want to think about:

1. **Test document choice** — KBR Innovation Studio? One of the Mission
   Zero NDAs? Or a synthetic test doc designed to exercise the three
   mechanics deliberately? (A synthetic doc is more controlled but
   less realistic.)
2. **Privacy posture for the spike** — word-mcp-live and docx-mcp both
   run 100% locally. But the prompts you send through Claude Desktop
   go through Anthropic. Acceptable for spike work?
3. **Should we also try `AnsonLai/docx-redline-mcp`?** It explicitly
   focuses on "real tracked changes and comments" and might be a third
   data point. ~30 min more setup. Skip unless you want belt-and-
   braces coverage.

If you want different defaults on any of these, tell me before sitting 2
starts and I'll update this doc.

---

*Generated sitting 1 of the markup spike — feat/markup-spike branch.
Subject to revision based on findings.*

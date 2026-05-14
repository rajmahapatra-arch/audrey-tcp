# Audrey TCP — install runbook

How to install the Audrey TCP plugin into your Claude environment to
verify the install paths work. This is the Stage A day-one spike.

**Goal:** confirm that a plugin pointing at our MCP server is installable
into at least one of Claude Desktop / Cowork / Claude for Microsoft 365.
We need ONE working install path to demo Stage A. More is better but not
required for the gate.

## Prerequisites

- Audrey TCP MCP server deployed and reachable. By default that's
  `https://mcp.audrey.xeqtor.com`. For first-time local testing the
  server can run on `http://localhost:8080`.
- A Claude account (Pro, Team, or Enterprise). Plugin install paths vary
  by tier — see "Known limits" below.

## Local-first install (recommended for the first spike)

Easier than dealing with deployed-MCP-server auth on day one. Run the MCP
server locally and install the plugin pointing at localhost.

### Step 1 — Run the MCP server locally

```bash
cd C:\dev\audrey-tcp\mcp-server
cp .env.example .env
# edit .env: leave SUPABASE_* blank for stub mode; PORT=8080
npm install
npm run dev
```

The server should log `Audrey MCP server listening on :8080`. Test with:

```bash
curl http://localhost:8080/health
# expect: {"status":"ok","service":"audrey-mcp",...}
```

### Step 2 — Switch the plugin's .mcp.json to point at localhost

Edit `C:\dev\audrey-tcp\.claude-plugin\.mcp.json`:

```json
{
  "mcpServers": {
    "audrey": {
      "url": "http://localhost:8080/mcp",
      "transport": "http"
    }
  }
}
```

> Don't commit this change. Reset before pushing.

### Step 3 — Install the plugin into Claude Desktop

Claude Desktop is the easiest target for a first spike — no marketplace
approval, no organization permissions.

**Option A: Direct config edit**

Open Claude Desktop's MCP config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the audrey server entry:

```json
{
  "mcpServers": {
    "audrey": {
      "command": "node",
      "args": ["C:\\dev\\audrey-tcp\\mcp-server\\dist\\index.js"],
      "env": {}
    }
  }
}
```

(Build the server first: `cd mcp-server && npm run build`.)

Restart Claude Desktop. The audrey MCP server should appear in the MCP
servers list (small icon, bottom of the chat input).

**Option B: Via Claude Code's plugin install (preferred if available)**

```bash
claude plugin install C:\dev\audrey-tcp
```

This reads `.claude-plugin/plugin.json` and registers the plugin's
skills and MCP servers.

### Step 4 — Verify

In Claude Desktop, type:

```
/audrey:matter-review
```

You should see the matter-review skill appear in the autocomplete. If
it does, the plugin's skills loaded successfully.

Then ask Claude to call the `get_matter` tool:

```
Call the audrey get_matter tool with matter_id 00000000-0000-0000-0000-000000000001
```

Claude should call the tool and return the stub matter data (Acme MSA in
negotiation, 12-month liability cap, etc.).

If that round-trip works, **Stage A's day-one spike has succeeded.**

## Deployed install (after local works)

Once local install is verified:

1. Deploy MCP server to Railway: `cd mcp-server && railway up`
2. Confirm `https://mcp.audrey.xeqtor.com/health` returns 200
3. Restore `.claude-plugin/.mcp.json` to point at the production URL
4. Repeat install steps for Cowork / Claude for Microsoft 365 (these
   require the plugin manifest to be reachable; either submit to the
   Cowork marketplace, or use developer install if available)

## Known limits

- **Plugin install in Claude for Microsoft 365** may still be in
  controlled preview as of May 2026. If the install path doesn't work
  yet, Stage A's gate falls back to Claude Desktop demo. Not a blocker
  but worth flagging.
- **Cowork plugin marketplace** has automated review for self-publish
  but turnaround time varies. Plan ~1 week before pilot day.
- **MCP transport** — we use Streamable HTTP per the current MCP spec.
  Older Claude clients may only support stdio transport — if so,
  Claude Desktop's `command/args` style (Option A above) is the
  fallback.

## When it doesn't work — common failures

- **"Server returned 401"** — auth not yet configured. The Stage A stub
  bypasses auth (firmId is hardcoded). If you're hitting 401, the
  deployed server has auth turned on; use the local-first path.
- **"Tool not found: get_matter"** — the plugin's skills loaded but the
  MCP server isn't connected. Check the server logs.
- **"Plugin manifest invalid"** — Claude's plugin loader is strict
  about the JSON schema. Run `npx ajv validate -s [schema] -d
  .claude-plugin/plugin.json` if Claude rejects it.

## Reporting back

After the spike, capture:

- Which install path(s) worked
- Which failed and why
- Screenshots of the plugin appearing in the Claude UI
- Logs from one full tool-call round-trip

This becomes Stage A's gate evidence.

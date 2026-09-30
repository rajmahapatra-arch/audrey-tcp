# Audrey TCP

**The matter-context plugin for Claude for Legal.**

Audrey TCP slots into Claude for Microsoft 365, Cowork, and Claude Code
as a plugin that brings per-matter, per-counterparty, per-client
intelligence into every conversation. Where Anthropic's legal plugins
encode a firm's playbook, Audrey TCP encodes the live state of a deal,
the counterparty's history, the client's settled positions, and the
privilege boundary between matters.

## What this repository contains

```
.claude-plugin/   Anthropic plugin manifest (plugin.json, .mcp.json, CLAUDE.md)
skills/           Plugin skills — markdown system prompts triggered by /commands
agents/           Plugin agents — scheduled or event-driven workflows
hooks/            Plugin hooks — pre/post tool-call enforcement
mcp-server/       The TypeScript MCP server exposing matter-intelligence tools
config-ui/        Web app at app.audrey.xeqtor.com for setup and review
migrations/       SQL migrations applied to the shared Supabase instance
docs/             Plan, install runbook, incident response, etc.
legal/            DPA template, privacy policy, ToS (placeholders for legal team)
```

## How it fits together

```
User in Word with Claude for Microsoft 365 sidebar
            ↓
Claude reasons about the request, matches an Audrey skill
            ↓
Skill instructs Claude to call Audrey MCP tools
            ↓
mcp.audrey.xeqtor.com → Supabase → matter context returned
            ↓
Claude composes a response that knows about the counterparty,
the matter state, the client's red lines, the deal history.
```

**Inference is always the user's own Anthropic subscription.** We never
call the Claude API. Our value is the schema, not the tokens.

## Status

Stage A — plugin scaffolding and stub MCP server. See
[`docs/audrey-tcp-plan.md`](docs/audrey-tcp-plan.md) for the full plan.

## License

Proprietary — Copyright (c) 2026 Xeqtor Ltd, all rights reserved. See
[LICENSE](LICENSE). This repository is not open source and no rights
are granted by access to it.

If plugin-marketplace distribution later requires a permissive
license, ONLY the thin plugin artifacts (`.claude-plugin/`, `skills/`)
will be mirrored to a separate public repository under Apache 2.0 —
the MCP server, extraction/diff engines, migrations, and docs stay in
this proprietary repository.

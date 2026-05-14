/**
 * Audrey TCP MCP server — stdio entry point.
 *
 * Used by Claude Desktop and any MCP client that prefers stdio
 * transport over HTTP/SSE. For HTTP clients (Railway deploy, future
 * remote MCP), see src/index.ts.
 *
 * CRITICAL: stdout is the MCP protocol channel. All logging MUST go
 * to stderr (process.stderr or console.error). Writing log lines to
 * stdout corrupts the MCP framing and breaks the connection.
 */

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getMatterTool, handleGetMatter } from './tools/getMatter.js';
import { listMattersTool, handleListMatters } from './tools/listMatters.js';
import {
  getCounterpartyHistoryTool,
  handleGetCounterpartyHistory,
} from './tools/getCounterpartyHistory.js';
import { isSupabaseConfigured } from './db/supabase.js';
import { auditAsync } from './audit.js';
import { resolveFirmId } from './auth.js';
import { randomUUID } from 'node:crypto';

const log = (...args: unknown[]) => console.error('[audrey-mcp]', ...args);

// ============================================================
// MCP server setup (mirrors index.ts; refactor to shared module
// in Stage A polish pass)
// ============================================================

const mcp = new McpServer(
  {
    name: 'audrey-tcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [getMatterTool, listMattersTool, getCounterpartyHistoryTool],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = randomUUID();
  log('tool call:', name, args, 'requestId:', requestId);

  // stdio: read firmId from AUDREY_FIRM_ID env (set in Claude Desktop
  // config). Falls back to stub-firm-id outside production.
  const auth = await resolveFirmId({ source: 'stdio' });
  const firmId = auth.firmId;
  const userId = auth.userId;

  try {
    let result;
    switch (name) {
      case 'get_matter':
        result = await handleGetMatter(args, firmId);
        break;
      case 'list_matters':
        result = await handleListMatters(args, firmId);
        break;
      case 'get_counterparty_history':
        result = await handleGetCounterpartyHistory(args, firmId);
        break;
      default:
        auditAsync({
          firmId,
          userId,
          action: `tool.${name}`,
          result: 'error',
          requestId,
          payload: { error: 'unknown_tool', args },
        });
        throw new Error(`Unknown tool: ${name}`);
    }

    auditAsync({
      firmId,
      userId,
      action: `tool.${name}`,
      result: 'success',
      requestId,
      payload: { args },
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditAsync({
      firmId,
      userId,
      action: `tool.${name}`,
      result: 'error',
      requestId,
      payload: { args, error: msg },
    });
    throw err;
  }
});

// ============================================================
// Connect stdio transport — this blocks waiting for messages
// ============================================================

const transport = new StdioServerTransport();
await mcp.connect(transport);

if (!isSupabaseConfigured()) {
  log(
    'SUPABASE_URL / SUPABASE_ANON_KEY not set — running in STUB mode. ' +
      'Tools will return hardcoded fixtures.'
  );
} else {
  log('Supabase configured — tools will read live data.');
}

log('Audrey MCP stdio server ready');

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
  tools: [getMatterTool],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log('tool call:', name, args);

  // TODO Stage A polish: extract firmId from authenticated session.
  // For stdio transport, auth is via the user's local Claude session;
  // we'll wire that in once OAuth is set up.
  const firmId = 'stub-firm-id';

  switch (name) {
    case 'get_matter':
      return handleGetMatter(args, firmId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ============================================================
// Connect stdio transport — this blocks waiting for messages
// ============================================================

const transport = new StdioServerTransport();
await mcp.connect(transport);

log('Audrey MCP stdio server ready');

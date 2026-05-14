/**
 * Audrey TCP MCP server — entry point.
 *
 * Stage A: stub MCP server exposing one tool (`get_matter`) returning
 * hardcoded data, plus a health endpoint for Railway. Designed to be
 * installable into Claude Desktop / Cowork / Claude for Microsoft 365
 * via the plugin's .mcp.json reference.
 *
 * Architecture discipline (enforced from day one):
 *   - MCP tools NEVER query Supabase directly. They go through repositories.
 *   - Repositories take `firmId` as a parameter and route to shared or
 *     dedicated database depending on tenant config.
 *   - The Supabase service-role key is NEVER used in tool handlers; it's
 *     reserved for migrations and admin tasks only.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';

import { getMatterTool, handleGetMatter } from './tools/getMatter.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined,
});

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);

// ============================================================
// MCP server setup
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

// Register tools — list and dispatch
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [getMatterTool],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  logger.info({ tool: name, args }, 'tool call');

  // TODO Stage A: extract authenticated user's firm_id from request context
  // For now, stub firm_id is hardcoded for development
  const firmId = 'stub-firm-id';

  switch (name) {
    case 'get_matter':
      return handleGetMatter(args, firmId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ============================================================
// HTTP server (Fastify) — wraps MCP server with health endpoint
// ============================================================

const app = Fastify({ logger: false });

await app.register(cors, {
  origin: true,
  credentials: true,
});

// Health endpoint for Railway
app.get('/health', async () => ({
  status: 'ok',
  service: 'audrey-mcp',
  version: '0.1.0',
  timestamp: new Date().toISOString(),
}));

// Root — informational
app.get('/', async () => ({
  service: 'audrey-tcp-mcp',
  message: 'Audrey TCP MCP server. Connect via Claude with the audrey-tcp plugin installed.',
  documentation: 'https://github.com/rajmahapatra-arch/audrey-tcp',
}));

// MCP transport — Streamable HTTP per MCP spec
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await mcp.connect(transport);

app.post('/mcp', async (request, reply) => {
  await transport.handleRequest(request.raw, reply.raw, request.body);
});

app.get('/mcp', async (request, reply) => {
  await transport.handleRequest(request.raw, reply.raw);
});

// ============================================================
// Start
// ============================================================

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info(`Audrey MCP server listening on :${PORT}`);
} catch (err) {
  logger.error(err, 'failed to start server');
  process.exit(1);
}

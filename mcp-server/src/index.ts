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
import { listMattersTool, handleListMatters } from './tools/listMatters.js';
import {
  getCounterpartyHistoryTool,
  handleGetCounterpartyHistory,
} from './tools/getCounterpartyHistory.js';
import { isSupabaseConfigured } from './db/supabase.js';
import { auditAsync } from './audit.js';
import { resolveFirmId } from './auth.js';
import { AsyncLocalStorage } from 'node:async_hooks';

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
  tools: [getMatterTool, listMattersTool, getCounterpartyHistoryTool],
}));

// Per-request context store. We can't pass `request` through the MCP
// SDK's CallTool dispatcher cleanly, so we capture the Authorization
// header in the Fastify route and read it back here via ALS.
const requestContext = new AsyncLocalStorage<{ bearerToken?: string }>();

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = crypto.randomUUID();
  logger.info({ tool: name, args, requestId }, 'tool call');

  // Resolve firmId from bearer token (validated via Supabase Auth) or
  // env-var fallback. Throws if neither is available in production.
  const ctx = requestContext.getStore();
  let firmId: string;
  let userId: string | null = null;
  try {
    const auth = await resolveFirmId({
      source: 'http',
      bearerToken: ctx?.bearerToken,
    });
    firmId = auth.firmId;
    userId = auth.userId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ requestId, error: msg }, 'auth failed');
    throw err; // transport translates to error response
  }

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

function extractBearer(authHeader: unknown): string | undefined {
  if (typeof authHeader !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1];
}

app.post('/mcp', async (request, reply) => {
  const bearerToken = extractBearer(request.headers.authorization);
  await requestContext.run({ bearerToken }, async () => {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
});

app.get('/mcp', async (request, reply) => {
  const bearerToken = extractBearer(request.headers.authorization);
  await requestContext.run({ bearerToken }, async () => {
    await transport.handleRequest(request.raw, reply.raw);
  });
});

// ============================================================
// Start
// ============================================================

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info(`Audrey MCP server listening on :${PORT}`);
  if (!isSupabaseConfigured()) {
    logger.warn(
      'SUPABASE_URL / SUPABASE_ANON_KEY not set — running in STUB mode. ' +
        'Repositories will return hardcoded fixtures. Set env vars in .env to read real data.'
    );
  } else {
    logger.info('Supabase configured — repositories will read live data.');
  }
} catch (err) {
  logger.error(err, 'failed to start server');
  process.exit(1);
}

/**
 * Audrey TCP MCP server — HTTP entry point (Streamable HTTP transport).
 *
 * Architecture discipline (enforced from day one):
 *   - MCP tools NEVER query Supabase directly. They go through repositories.
 *   - Repositories take `firmId` as a parameter and route to shared or
 *     dedicated database depending on tenant config.
 *   - The Supabase service-role key is NEVER used in tool handlers; it's
 *     reserved for migrations and admin tasks only.
 *
 * Transport pattern (MCP Streamable HTTP spec):
 *   - ONE McpServer + ONE transport per CLIENT SESSION.
 *   - `Mcp-Session-Id` header routes subsequent requests to the right
 *     transport.
 *   - First request (initialize) creates a new server+transport pair.
 *   - We do NOT use a singleton transport — the SDK enforces "one
 *     session per transport instance" and throws "Server already
 *     initialized" on the second initialize.
 */

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';

import { getMatterTool, handleGetMatter } from './tools/getMatter.js';
import { listMattersTool, handleListMatters } from './tools/listMatters.js';
import {
  getCounterpartyHistoryTool,
  handleGetCounterpartyHistory,
} from './tools/getCounterpartyHistory.js';
import {
  getMatterByDocumentTool,
  handleGetMatterByDocument,
} from './tools/getMatterByDocument.js';
import {
  getOpenPositionsTool,
  handleGetOpenPositions,
  getSettledPositionsTool,
  handleGetSettledPositions,
  getPositionHistoryTool,
  handleGetPositionHistory,
  addPositionTool,
  handleAddPosition,
} from './tools/positionTools.js';
import {
  audreyCheckDraftTool,
  handleAudreyCheckDraft,
  searchMatterTextTool,
  handleSearchMatterText,
} from './tools/extractionTools.js';
import {
  uploadDocumentTool,
  handleUploadDocument,
} from './tools/uploadDocument.js';
import {
  revokeMySessionTool,
  handleRevokeMySession,
  revokeUserSessionTool,
  handleRevokeUserSession,
} from './tools/sessionTools.js';
import { isSupabaseConfigured } from './db/supabase.js';
import { auditAsync } from './audit.js';
import { resolveFirmId } from './auth.js';
import { registerMetadataRoutes } from './oauth/metadata.js';
import { registerDCREndpoint } from './oauth/register.js';
import { registerAuthorizeEndpoint } from './oauth/authorize.js';
import { registerTokenEndpoint } from './oauth/token.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined,
});

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);

// Per-request bearer-token context — ALS so MCP tool handlers can
// read it without us threading FastifyRequest through the SDK.
const requestContext = new AsyncLocalStorage<{ bearerToken?: string }>();

// ============================================================
// McpServer factory — fresh instance per client session.
// ============================================================

function createMcpServer(): McpServer {
  const mcp = new McpServer(
    {
      name: 'audrey',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool registry (advertised on ListTools)
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      getMatterByDocumentTool,
      getMatterTool,
      listMattersTool,
      getCounterpartyHistoryTool,
      getOpenPositionsTool,
      getSettledPositionsTool,
      getPositionHistoryTool,
      addPositionTool,
      audreyCheckDraftTool,
      searchMatterTextTool,
      uploadDocumentTool,
      revokeMySessionTool,
      revokeUserSessionTool,
    ],
  }));

  // Tool dispatcher (handles CallTool)
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const requestId = randomUUID();
    logger.info({ tool: name, args, requestId }, 'tool call');

    // Resolve firmId from bearer token (HTTP) or env (stdio/dev).
    // Throws in production if neither is available.
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
      throw err;
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
        case 'get_matter_by_document':
          result = await handleGetMatterByDocument(args, firmId);
          break;
        case 'get_open_positions':
          result = await handleGetOpenPositions(args, firmId);
          break;
        case 'get_settled_positions':
          result = await handleGetSettledPositions(args, firmId);
          break;
        case 'get_position_history':
          result = await handleGetPositionHistory(args, firmId);
          break;
        case 'add_position':
          result = await handleAddPosition(args, firmId, userId);
          break;
        case 'audrey_check_draft':
          result = await handleAudreyCheckDraft(args, firmId);
          break;
        case 'search_matter_text':
          result = await handleSearchMatterText(args, firmId);
          break;
        case 'upload_document':
          result = await handleUploadDocument(args, firmId, userId);
          break;
        case 'revoke_my_session':
          result = await handleRevokeMySession(args, firmId, userId);
          break;
        case 'revoke_user_session':
          result = await handleRevokeUserSession(args, firmId, userId);
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

  return mcp;
}

// ============================================================
// Stateless mode — see /mcp handler below for rationale.
// (transports map removed; we create a fresh transport per request.)
// ============================================================

// ============================================================
// HTTP server (Fastify)
// ============================================================

const app = Fastify({ logger: false });

await app.register(cors, {
  origin: true,
  credentials: true,
  exposedHeaders: ['Mcp-Session-Id'], // so browser clients can read it
});

// Form-encoded body parsing for OAuth endpoints (RFC 6749 requires
// application/x-www-form-urlencoded on /token).
await app.register(formbody);

// ============================================================
// OAuth 2.0 endpoints (RFC 6749 + 7591 + 7636 + 8414 + 9728)
// ============================================================
registerMetadataRoutes(app);
registerDCREndpoint(app);
registerAuthorizeEndpoint(app);
registerTokenEndpoint(app);

// ============================================================
// Health + diagnostic
// ============================================================

app.get('/health', async () => ({
  status: 'ok',
  service: 'audrey-mcp',
  version: '0.1.0',
  timestamp: new Date().toISOString(),
}));

// TEMPORARY — env-presence diagnostic. Remove after OAuth is verified.
app.get('/_debug/env', async () => {
  const probe = (name: string) => {
    const v = process.env[name];
    return v ? { set: true, length: v.length, startsWith: v.slice(0, 4) } : { set: false };
  };
  return {
    SUPABASE_URL: probe('SUPABASE_URL'),
    SUPABASE_ANON_KEY: probe('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: probe('SUPABASE_SERVICE_ROLE_KEY'),
    AUDREY_JWT_PRIVATE_KEY: probe('AUDREY_JWT_PRIVATE_KEY'),
    AUDREY_STATE_SECRET: probe('AUDREY_STATE_SECRET'),
    AUDREY_BASE_URL: probe('AUDREY_BASE_URL'),
    NODE_ENV: process.env.NODE_ENV ?? '(unset)',
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN ?? '(unset)',
  };
});

app.get('/', async () => ({
  service: 'audrey-tcp-mcp',
  message: 'Audrey TCP MCP server. Connect via Claude with the audrey-tcp plugin installed.',
  documentation: 'https://github.com/rajmahapatra-arch/audrey-tcp',
}));

// ============================================================
// MCP endpoint — routed by Mcp-Session-Id per spec
// ============================================================

function extractBearer(authHeader: unknown): string | undefined {
  if (typeof authHeader !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1];
}

/**
 * Stateless /mcp handler.
 *
 * Why stateless rather than per-session: we don't use SSE streaming
 * responses. Every tool call is a simple request-reply. Stateful
 * session tracking was creating brittleness — clients that kept their
 * session id but talked to a server instance that had forgotten it
 * (idle timeout, restart, etc.) got 400'd. Claude for Word hit this
 * after ~15 min idle.
 *
 * In stateless mode we create a fresh McpServer + transport per
 * request. Slight per-request overhead, total robustness.
 */
async function handleMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const bearerToken = extractBearer(request.headers.authorization);

  // Log the request shape (very useful for debugging unfamiliar client behaviour)
  const bodyMethod =
    request.body && typeof request.body === 'object' && 'method' in request.body
      ? (request.body as { method?: string }).method
      : undefined;
  console.error('[audrey-mcp]', request.method, '/mcp method:', bodyMethod ?? '(none)');

  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    // undefined disables session tracking — each request stands alone.
    sessionIdGenerator: undefined,
  });
  await mcp.connect(transport);

  await requestContext.run({ bearerToken }, async () => {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}

app.post('/mcp', async (request, reply) => {
  await handleMcpRequest(request, reply);
  return reply;
});

app.get('/mcp', async (request, reply) => {
  await handleMcpRequest(request, reply);
  return reply;
});

app.delete('/mcp', async (request, reply) => {
  await handleMcpRequest(request, reply);
  return reply;
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

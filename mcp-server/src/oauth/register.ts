/**
 * POST /register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * Claude.ai (and any other MCP-aware client) hits this with metadata
 * about itself: client_name, redirect_uris, etc. We mint a client_id,
 * persist it, and return.
 *
 * No authentication required on this endpoint — that's the point of
 * dynamic registration. Spam prevention is via:
 *   - PKCE-only flow (no client_secrets to harvest)
 *   - Rate limiting at the edge (Stage B: Fastify rate-limit plugin)
 *   - Status='active' filter; revocation via admin path
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { oauthRepository } from '../repositories/oauth.js';

const RegistrationRequest = z.object({
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
  // Additional metadata (logo_uri, policy_uri, etc.) — accepted and
  // stored in the row's metadata column, but not validated.
}).passthrough();

export function registerDCREndpoint(app: FastifyInstance): void {
  app.post('/register', async (request, reply) => {
    const parsed = RegistrationRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_client_metadata',
        error_description: parsed.error.message,
      };
    }

    const body = parsed.data;

    try {
      const client = await oauthRepository.registerClient({
        clientName: body.client_name ?? 'Unnamed MCP client',
        redirectUris: body.redirect_uris,
        grantTypes: body.grant_types,
        responseTypes: body.response_types,
        scope: body.scope,
      });

      // RFC 7591 response shape
      return {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        scope: client.scope,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        // No client_secret: PKCE-only public clients.
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log?.error({ err: msg }, 'DCR failure');
      reply.code(500);
      return {
        error: 'server_error',
        error_description: 'Failed to register client',
      };
    }
  });
}

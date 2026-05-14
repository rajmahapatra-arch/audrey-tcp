/**
 * POST /token — OAuth 2.0 token endpoint.
 *
 * Claude.ai POSTs here with the authorization code it received from
 * /authorize, plus the PKCE code_verifier. We verify the code, verify
 * the PKCE challenge, and return a signed JWT access token.
 *
 * Spec: RFC 6749 §4.1.3 + RFC 7636 (PKCE).
 *
 * What we DON'T do (Stage A):
 *   - Refresh tokens. Access tokens last 1 hour; user re-auths after.
 *     Stage B adds refresh tokens once token rotation is wired.
 *   - Token introspection (RFC 7662). Stage B if a separate resource
 *     server appears.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { oauthRepository } from '../repositories/oauth.js';
import { signAccessToken } from './jwt.js';
import { getBaseUrl } from './metadata.js';

const TokenRequest = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  client_id: z.string().min(1),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
});

export function registerTokenEndpoint(app: FastifyInstance): void {
  app.post('/token', async (request, reply) => {
    const parsed = TokenRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_request',
        error_description: parsed.error.message,
      };
    }

    const body = parsed.data;

    // Stage A: refresh_token not supported. Return invalid_grant so
    // clients fall back to a full re-auth (which is what we want until
    // refresh is wired in Stage B).
    if (body.grant_type === 'refresh_token') {
      reply.code(400);
      return {
        error: 'unsupported_grant_type',
        error_description: 'Refresh tokens are not yet issued. Re-authenticate via /authorize.',
      };
    }

    // ===== authorization_code grant =====
    if (!body.code || !body.redirect_uri || !body.code_verifier) {
      reply.code(400);
      return {
        error: 'invalid_request',
        error_description: 'code, redirect_uri, and code_verifier are required',
      };
    }

    const client = await oauthRepository.getClient(body.client_id);
    if (!client) {
      reply.code(401);
      return { error: 'invalid_client', error_description: 'Unknown client_id' };
    }

    const redeemed = await oauthRepository.redeemCode(body.code);
    if (!redeemed) {
      reply.code(400);
      return {
        error: 'invalid_grant',
        error_description: 'Authorization code is invalid, expired, or already used',
      };
    }

    // Verify the redirect_uri matches what was used at /authorize
    if (redeemed.redirectUri !== body.redirect_uri) {
      reply.code(400);
      return {
        error: 'invalid_grant',
        error_description: 'redirect_uri mismatch',
      };
    }

    // Verify the client_id matches the one the code was issued to
    if (redeemed.clientId !== body.client_id) {
      reply.code(400);
      return {
        error: 'invalid_grant',
        error_description: 'client_id mismatch',
      };
    }

    // ===== PKCE verification =====
    if (!verifyPkce(body.code_verifier, redeemed.codeChallenge, redeemed.codeChallengeMethod)) {
      reply.code(400);
      return {
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      };
    }

    // ===== Mint the access token =====
    const base = getBaseUrl();
    const { token, expiresIn } = await signAccessToken({
      userId: redeemed.userId,
      firmId: redeemed.firmId,
      clientId: redeemed.clientId,
      scope: redeemed.scope,
      audience: `${base}/mcp`,
      issuer: base,
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: redeemed.scope,
    };
  });
}

function verifyPkce(
  verifier: string,
  challenge: string,
  method: 'S256' | 'plain'
): boolean {
  if (method === 'plain') {
    const a = Buffer.from(verifier);
    const b = Buffer.from(challenge);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // S256: BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))
  const expected = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

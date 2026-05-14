/**
 * OAuth 2.0 metadata endpoints.
 *
 * These are the four well-known discovery URLs that Claude.ai (and any
 * other MCP-aware client) hits when probing a custom connector:
 *
 *   1. /.well-known/oauth-protected-resource
 *   2. /.well-known/oauth-protected-resource/mcp    (path-prefixed variant)
 *   3. /.well-known/oauth-authorization-server
 *   4. /.well-known/openid-configuration            (for OIDC clients; we
 *                                                    point them at the
 *                                                    OAuth metadata too)
 *
 * We are BOTH the resource server AND the authorization server. In a
 * larger deployment those would split (auth server lives at
 * auth.audrey.xeqtor.com; resource server at mcp.audrey.xeqtor.com).
 * For Stage A they're the same Fastify app.
 *
 * Spec references:
 *   - RFC 9728 (Protected Resource Metadata)
 *   - RFC 8414 (Authorization Server Metadata)
 *   - MCP 2025-06-18 OAuth profile
 */

import type { FastifyInstance } from 'fastify';

/**
 * Returns the base URL the server is reachable at. Used for absolute
 * URLs in metadata responses. In production this is the Railway domain
 * (or future custom domain). Override with AUDREY_BASE_URL env var.
 */
export function getBaseUrl(): string {
  const explicit = process.env.AUDREY_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');

  // Railway provides RAILWAY_PUBLIC_DOMAIN at runtime.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}`;

  // Local dev fallback
  const port = process.env.PORT ?? '8080';
  return `http://localhost:${port}`;
}

export function registerMetadataRoutes(app: FastifyInstance): void {
  const protectedResourceMetadata = () => {
    const base = getBaseUrl();
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://github.com/rajmahapatra-arch/audrey-tcp',
      scopes_supported: ['mcp:tools'],
    };
  };

  // Per RFC 9728 — protected resource metadata
  app.get('/.well-known/oauth-protected-resource', async () =>
    protectedResourceMetadata()
  );

  // Path-prefixed variant for clients that scope discovery to the
  // resource path (Claude.ai does this).
  app.get('/.well-known/oauth-protected-resource/mcp', async () =>
    protectedResourceMetadata()
  );

  // Per RFC 8414 — authorization server metadata
  app.get('/.well-known/oauth-authorization-server', async () => {
    const base = getBaseUrl();
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], // PKCE public clients
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools'],
      subject_types_supported: ['public'],
      // We don't issue ID tokens (not OIDC); MCP spec only needs OAuth.
    };
  });

  // OIDC discovery shim — point OIDC-aware clients at our OAuth metadata.
  // Not strictly required by MCP spec, but cheap and harmless.
  app.get('/.well-known/openid-configuration', async (_req, reply) => {
    reply.redirect(307, '/.well-known/oauth-authorization-server');
  });

  // JWKS endpoint — publish the public key so clients can verify
  // tokens without contacting us. Stage A returns a single key; Stage
  // B adds key rotation with kid.
  app.get('/.well-known/jwks.json', async () => {
    // Lazy import to avoid bootstrapping the JWT module just to serve
    // metadata to anonymous probes.
    const { getPublicKeyPem } = await import('./jwt.js');
    const pem = await getPublicKeyPem();
    // Convert SPKI PEM to JWK. jose has a helper for this.
    const { importSPKI, exportJWK } = await import('jose');
    const key = await importSPKI(pem, 'RS256');
    const jwk = await exportJWK(key as any);
    return {
      keys: [
        {
          ...jwk,
          use: 'sig',
          alg: 'RS256',
          kid: 'audrey-tcp-2026-05',
        },
      ],
    };
  });
}

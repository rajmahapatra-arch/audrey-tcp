// OAuth for the Granola MCP server.
//
// Primary flow: authorization code + PKCE (S256) with a loopback redirect
// (http://127.0.0.1:<port>/callback), driven by the MCP SDK's OAuth client helpers.
// Fallback: device-code flow (`connect --device`).
//
// Tokens, the registered client and the PKCE verifier live in a DPAPI-encrypted
// SecretStore under %LOCALAPPDATA%\granola-filer\ -- never on disk in plaintext.

import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js';

export const SCOPE = 'mcp offline_access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class FilerOAuthProvider {
  /**
   * @param {object} o
   * @param {import('./dpapi.js').SecretStore} o.store
   * @param {string} o.redirectUrl
   * @param {(url: URL) => void} [o.onRedirect] called when the user must approve in a browser.
   */
  constructor({ store, redirectUrl, onRedirect, extraScopes = ['offline_access'] }) {
    this.store = store;
    this._redirectUrl = redirectUrl;
    this.onRedirect = onRedirect;
    this.extraScopes = extraScopes;
    this.lastState = undefined;
    this.needsUserApproval = false;
  }

  get redirectUrl() { return this._redirectUrl; }

  get clientMetadata() {
    return {
      client_name: 'Granola Filer (personal, Raj Mahapatra)',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token', DEVICE_GRANT],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    };
  }

  state() {
    this.lastState = crypto.randomBytes(16).toString('hex');
    return this.lastState;
  }

  clientInformation() { return this.store.get().clientInformation; }
  saveClientInformation(info) { this.store.update({ clientInformation: info }); }
  tokens() { return this.store.get().tokens; }
  saveTokens(tokens) { this.store.update({ tokens: { ...tokens, obtained_at: Date.now() } }); }
  saveCodeVerifier(v) { this.store.update({ codeVerifier: v }); }
  codeVerifier() {
    const v = this.store.get().codeVerifier;
    if (!v) throw new Error('No PKCE code verifier saved');
    return v;
  }
  discoveryState() { return this.store.get().discoveryState; }
  saveDiscoveryState(s) { this.store.update({ discoveryState: s }); }

  invalidateCredentials(scope) {
    const keys = {
      all: ['clientInformation', 'tokens', 'codeVerifier', 'discoveryState'],
      client: ['clientInformation'],
      tokens: ['tokens'],
      verifier: ['codeVerifier'],
      discovery: ['discoveryState'],
    }[scope] || [];
    this.store.clear(keys);
  }

  redirectToAuthorization(url) {
    this.needsUserApproval = true;
    // The SDK requests the resource's scope ("mcp"). Add offline_access so Granola issues
    // a refresh token and the scheduled task keeps working without re-approving.
    const scopes = new Set((url.searchParams.get('scope') || '').split(' ').filter(Boolean));
    const before = scopes.size;
    for (const s of this.extraScopes) scopes.add(s);
    if (scopes.size !== before) {
      url.searchParams.set('scope', [...scopes].join(' '));
      if (scopes.has('offline_access')) url.searchParams.set('prompt', 'consent');
    }
    if (this.onRedirect) this.onRedirect(url);
  }
}

/** Open a URL in the default browser without going through cmd.exe quoting. */
export function openBrowser(url) {
  execFile('rundll32.exe', ['url.dll,FileProtocolHandler', String(url)], { windowsHide: true }, () => {});
}

/**
 * Start a one-shot loopback HTTP listener for the OAuth redirect.
 * Resolves `waitForCode()` with {code, state} or rejects on error/timeout.
 */
export function startLoopback(port) {
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Granola Filer</title>
<body style="font-family:Segoe UI,sans-serif;padding:2em"><h2>${msg}</h2><p>You can close this tab.</p></body>`;
    if (err) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Granola sign-in was not completed.'));
      rejectCode(new Error(`Authorization failed: ${err}${err === 'invalid_scope' ? ' -- set "oauthExtraScopes": [] in config.json and run connect again' : ''}`));
    } else if (code) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Granola Filer is connected.'));
      resolveCode({ code, state: u.searchParams.get('state') });
    } else {
      res.writeHead(400).end();
    }
  });
  const listening = new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', res);
  });
  return {
    listening,
    waitForCode(timeoutMs) {
      let t;
      const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser approval`)), timeoutMs);
      });
      return Promise.race([codePromise, timeout]).finally(() => clearTimeout(t));
    },
    close() { server.close(); },
  };
}

/**
 * Device-code fallback. Registers the client if needed, prints the code, polls the
 * token endpoint and saves tokens through the provider.
 */
export async function deviceCodeFlow(provider, mcpUrl, { timeoutMs = 300000, print = console.log } = {}) {
  const prm = await discoverOAuthProtectedResourceMetadata(mcpUrl);
  const asUrl = prm.authorization_servers[0];
  const metadata = await discoverAuthorizationServerMetadata(asUrl);
  let client = provider.clientInformation();
  if (!client) {
    client = await registerClient(asUrl, { metadata, clientMetadata: provider.clientMetadata });
    provider.saveClientInformation(client);
  }
  const body = new URLSearchParams({ client_id: client.client_id, scope: SCOPE, resource: prm.resource || mcpUrl });
  const r = await fetch(metadata.device_authorization_endpoint, { method: 'POST', body });
  if (!r.ok) throw new Error(`Device authorization failed: HTTP ${r.status}`);
  const d = await r.json();
  print(`\nOpen this page and enter the code ${d.user_code}:\n  ${d.verification_uri_complete || d.verification_uri}\n`);
  openBrowser(d.verification_uri_complete || d.verification_uri);
  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + Math.min(timeoutMs, (d.expires_in || 600) * 1000);
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, interval));
    const tr = await fetch(metadata.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: client.client_id, resource: prm.resource || mcpUrl }),
    });
    const tj = await tr.json().catch(() => ({}));
    if (tr.ok && tj.access_token) { provider.saveTokens(tj); return; }
    if (tj.error === 'authorization_pending') continue;
    if (tj.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`Device flow failed: ${tj.error || `HTTP ${tr.status}`}`);
  }
  throw new Error('Timed out waiting for device approval');
}

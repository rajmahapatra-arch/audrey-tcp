// Thin, guarded wrapper around the official Granola MCP server.
//
// Guards:
//  * a hard block-list: switch_workspace and sign_out change Raj's Granola app state,
//    and query_granola_meetings is not needed -- none of them can ever be called.
//  * a call-spacing limiter (default 1.2 s between calls => max 50/min; Granola's limit ~100/min).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export const BLOCKED_TOOLS = new Set(['switch_workspace', 'sign_out', 'query_granola_meetings']);
// Only these read-only tools may ever be called. Granola also offers write tools
// (create_folder, add_note_to_folder, update_private_notes, generate_summary, ...) -- never used.
export const ALLOWED_TOOLS = new Set(['get_account_info', 'list_meeting_folders', 'list_meetings', 'get_meetings', 'get_meeting_transcript']);

export class NeedsReconnectError extends Error {
  constructor() {
    super('Granola sign-in has expired or is missing. Run:  node src/cli.js connect');
    this.name = 'NeedsReconnectError';
  }
}

export function assertAllowed(name) {
  if (BLOCKED_TOOLS.has(name) || !ALLOWED_TOOLS.has(name)) throw new Error(`Refusing to call Granola tool "${name}" (not on the read-only allow-list)`);
}

export class GranolaClient {
  constructor({ mcpUrl, provider, minCallGapMs = 1200 }) {
    this.mcpUrl = mcpUrl;
    this.provider = provider;
    this.minCallGapMs = minCallGapMs;
    this.lastCallAt = 0;
    this.chain = Promise.resolve();
    this.calls = 0;
  }

  _newTransport() {
    this.transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: this.provider });
    this.client = new Client({ name: 'granola-filer', version: '0.1.0' });
    return this.transport;
  }

  /** Connect. Throws UnauthorizedError if the user has to approve in a browser. */
  async connect() {
    this._newTransport();
    await this.client.connect(this.transport);
  }

  /** Complete an authorization-code flow and reconnect. */
  async finishAuth(code) {
    await this.transport.finishAuth(code);
    await this.connect();
  }

  async listTools() {
    return this._spaced(() => this.client.listTools());
  }

  /** Call a tool and return {text, json, structured, isError}. */
  async call(name, args = {}) {
    assertAllowed(name);
    const res = await this._spaced(() => this.client.callTool({ name, arguments: args }));
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let json;
    if (res.structuredContent) json = res.structuredContent;
    else {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    if (res.isError) {
      // Do not echo the error text: it may quote meeting content.
      const e = new Error(`Granola tool ${name} returned an error`);
      e.detail = text;
      throw e;
    }
    return { text, json, structured: res.structuredContent, isError: !!res.isError };
  }

  _spaced(fn) {
    const run = async () => {
      const wait = this.lastCallAt + this.minCallGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      this.calls += 1;
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async close() {
    try { await this.client?.close(); } catch { /* ignore */ }
  }
}

/** Open a connection for non-interactive use (dry-run/run). Never opens a browser. */
export async function openNonInteractive({ config, provider }) {
  const g = new GranolaClient({ mcpUrl: config.mcpUrl, provider, minCallGapMs: config.minCallGapMs });
  if (!provider.tokens()) throw new NeedsReconnectError();
  try {
    await g.connect();
  } catch (e) {
    if (e instanceof UnauthorizedError || provider.needsUserApproval) throw new NeedsReconnectError();
    throw e;
  }
  return g;
}

export { UnauthorizedError };

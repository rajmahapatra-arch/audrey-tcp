// `connect`: OAuth sign-in, tool discovery, account check.

import fs from 'node:fs';
import path from 'node:path';
import { appDir, files, log } from './config.js';
import { SecretStore } from './dpapi.js';
import { FilerOAuthProvider, startLoopback, openBrowser, deviceCodeFlow } from './oauth.js';
import { GranolaClient, UnauthorizedError } from './granola.js';
import { loadState, saveState } from './state.js';
import { parseAccountInfo } from './parse.js';

export function makeProvider(config, { interactive = false, print = console.log } = {}) {
  const store = new SecretStore(files.secrets());
  const redirectUrl = `http://127.0.0.1:${config.oauthPort}/callback`;
  return new FilerOAuthProvider({
    store,
    redirectUrl,
    extraScopes: config.oauthExtraScopes ?? ['offline_access'],
    onRedirect: interactive
      ? (url) => {
        print('\nOpening Granola sign-in in your browser. If it does not open, paste this URL into your browser:\n');
        print(`  ${url.toString()}\n`);
        print('Waiting for you to approve (up to 10 minutes). Keep this window open until it says "Connected".');
        openBrowser(url);
      }
      : undefined,
  });
}

export async function connect(config, { device = false, timeoutMs = 600000, print = console.log } = {}) {
  const provider = makeProvider(config, { interactive: true, print });
  // The registered client must carry exactly this redirect URI; re-register if the port changed.
  const saved = provider.clientInformation();
  if (saved && !(saved.redirect_uris || []).includes(provider.redirectUrl)) {
    print('Redirect address changed since the last sign-in; registering this app with Granola again.');
    provider.invalidateCredentials('client');
  }
  print(`Listening for the Granola sign-in on ${provider.redirectUrl} for up to ${Math.round(timeoutMs / 60000)} minutes.`);
  const g = new GranolaClient({ mcpUrl: config.mcpUrl, provider, minCallGapMs: config.minCallGapMs });

  if (device) {
    await deviceCodeFlow(provider, config.mcpUrl, { timeoutMs, print });
    await g.connect();
  } else {
    const loop = startLoopback(config.oauthPort);
    await loop.listening;
    try {
      try {
        await g.connect();
      } catch (e) {
        if (!(e instanceof UnauthorizedError) && !provider.needsUserApproval) throw e;
        const { code, state } = await loop.waitForCode(timeoutMs);
        print('Browser approval received; exchanging the code for tokens...');
        if (provider.lastState && state !== provider.lastState) throw new Error('OAuth state mismatch -- aborting');
        await g.finishAuth(code);
        print('Token exchange succeeded.');
      }
    } finally {
      loop.close();
    }
  }
  print('Connected to Granola.');
  const hasRefresh = !!provider.tokens()?.refresh_token;
  log(`connect: OAuth OK (refresh token: ${hasRefresh ? 'yes' : 'no'})`);
  if (!hasRefresh) {
    print('WARNING: Granola did not issue a refresh token, so you may need to run connect again when the sign-in expires.');
  }

  // Tool discovery -- schemas only.
  const tools = await g.listTools();
  const schemaFile = path.join(appDir(), 'tools-schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(tools.tools.map((t) => ({
    name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema,
  })), null, 2), 'utf8');
  print(`Discovered ${tools.tools.length} Granola tools (schemas saved to ${schemaFile}).`);

  const acct = parseAccountInfo(await g.call('get_account_info'));
  print(`Account:   ${acct.email || '(email not reported)'}`);
  print(`Workspace: ${acct.workspace || '(workspace not reported)'}`);

  const state = loadState(files.state());
  if (state.account && state.account.workspace && acct.workspace && state.account.workspace !== acct.workspace) {
    print(`\nNOTE: the recorded workspace was "${state.account.workspace}". It is now "${acct.workspace}".`);
    print('The recorded workspace has been updated to the current one because you ran connect.');
  }
  state.account = { ...acct, recordedAt: new Date().toISOString() };
  saveState(files.state(), state);
  await g.close();
  return acct;
}

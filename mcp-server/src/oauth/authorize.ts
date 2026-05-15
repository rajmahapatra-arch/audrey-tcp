/**
 * /authorize — OAuth 2.0 authorization endpoint.
 *
 * Flow (Stage A, magic-link variant):
 *
 *   1. Claude.ai redirects the user's browser to:
 *      GET /authorize?response_type=code&client_id=X&redirect_uri=Y
 *                    &code_challenge=Z&code_challenge_method=S256
 *                    &state=...&scope=mcp:tools
 *
 *   2. We render a minimal HTML page: "Sign in to Audrey — enter your
 *      work email". The OAuth params are stashed in hidden form fields.
 *
 *   3. User submits email. We:
 *      a. Look up the Supabase Auth user by email.
 *      b. If found, send them a magic link. The magic link URL points
 *         back to /authorize/callback with the original OAuth state
 *         packed into the redirectTo query string.
 *      c. Show a "check your email" page.
 *
 *   4. User clicks magic link in email. Supabase verifies, redirects
 *      to /authorize/callback?access_token=...&state=<packed-oauth>.
 *
 *   5. We pull the Supabase session, read user_id and firm_id from
 *      app_metadata, mint an OAuth code, redirect to Claude.ai's
 *      redirect_uri with code + the original state value.
 *
 *   6. Claude.ai exchanges the code at /token for the JWT.
 *
 * Security notes:
 *   - Email is the auth factor. If the user's email is compromised so
 *     is their Audrey access. For Stage C we add MFA via Supabase
 *     (TOTP enrollment).
 *   - The "stashed OAuth state" is packed into a signed cookie (or the
 *     redirectTo URL) — Stage A uses a URL-packed approach with HMAC
 *     to prevent tampering.
 *   - We DO NOT auto-create users. The user must already exist
 *     (provisioned via scripts/onboard.ts). Unknown emails get a
 *     generic "if this email is registered, you'll get a link" message
 *     to avoid enumeration.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { oauthRepository } from '../repositories/oauth.js';
import { getBaseUrl } from './metadata.js';

// ============================================================
// State signing (prevents tampering with packed OAuth params)
// ============================================================

function getStateSecret(): string {
  const secret = process.env.AUDREY_STATE_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUDREY_STATE_SECRET must be set in production');
    }
    // Dev fallback — stable per process
    return 'dev-only-state-secret-change-me';
  }
  return secret;
}

interface PackedState {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  scope: string;
  state: string; // client's state value
  iat: number;
}

function packState(s: PackedState): string {
  const json = JSON.stringify(s);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = createHmac('sha256', getStateSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function unpackState(packed: string): PackedState | null {
  const [b64, sig] = packed.split('.');
  if (!b64 || !sig) return null;
  const expected = createHmac('sha256', getStateSecret()).update(b64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as PackedState;
    // Stale state (>15 min) is rejected
    if (Date.now() - parsed.iat > 15 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================
// Supabase service-role client (used for auth admin actions)
// ============================================================

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ============================================================
// HTML helpers (minimal, server-rendered)
// ============================================================

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Audrey</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 480px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p { color: #555; line-height: 1.5; }
    form { margin-top: 24px; }
    label { display: block; font-size: 14px; margin-bottom: 6px; color: #333; }
    input[type=email] { width: 100%; padding: 12px; font-size: 16px;
                        border: 1px solid #ccc; border-radius: 6px;
                        box-sizing: border-box; }
    button { margin-top: 16px; padding: 12px 20px; font-size: 16px;
             background: #1a1a1a; color: white; border: none;
             border-radius: 6px; cursor: pointer; }
    button:hover { background: #333; }
    .small { font-size: 13px; color: #888; margin-top: 32px; }
    .error { color: #c00; margin-top: 12px; font-size: 14px; }
  </style>
</head>
<body>
${body}
<p class="small">Audrey — context that travels with the matter.</p>
</body>
</html>`;
}

// ============================================================
// Routes
// ============================================================

const AuthorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.enum(['S256', 'plain']).default('S256'),
  scope: z.string().optional(),
  state: z.string().optional(),
});

const AuthorizeForm = z.object({
  email: z.string().email(),
  packed_state: z.string().min(1),
});

const CallbackQuery = z.object({
  packed_state: z.string().min(1),
  // Supabase appends these on success
  access_token: z.string().optional(),
  type: z.string().optional(),
  // ...we read user info via the supabase admin API using the access_token
});

export function registerAuthorizeEndpoint(app: FastifyInstance): void {
  // -------------------------------------------------------------
  // GET /authorize — entry from Claude.ai
  // -------------------------------------------------------------
  app.get('/authorize', async (request, reply) => {
    const parsed = AuthorizeQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).type('text/html');
      return htmlPage(
        'Invalid request',
        `<h1>Sign-in error</h1>
         <p>The sign-in request is missing required parameters. Please return to your app and try again.</p>
         <p class="error">${parsed.error.message}</p>`
      );
    }

    const q = parsed.data;

    // Validate the client_id is a registered client
    const client = await oauthRepository.getClient(q.client_id);
    if (!client) {
      reply.code(400).type('text/html');
      return htmlPage(
        'Unknown client',
        `<h1>Sign-in error</h1>
         <p>This app isn't registered with Audrey. If you're seeing this, your MCP client may need to re-register.</p>`
      );
    }

    // Validate redirect_uri is allowed for this client
    if (!client.redirectUris.includes(q.redirect_uri)) {
      reply.code(400).type('text/html');
      return htmlPage(
        'Invalid redirect',
        `<h1>Sign-in error</h1>
         <p>This redirect URL isn't allowed for this client.</p>`
      );
    }

    const packed = packState({
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
      scope: q.scope ?? 'mcp:tools',
      state: q.state ?? '',
      iat: Date.now(),
    });

    reply.type('text/html');
    return htmlPage(
      'Sign in',
      `<h1>Sign in to Audrey</h1>
       <p><strong>${escapeHtml(client.clientName)}</strong> is requesting access to your firm's matter intelligence.</p>
       <form method="POST" action="/authorize/email">
         <label for="email">Work email</label>
         <input id="email" name="email" type="email" autocomplete="email" required autofocus>
         <input type="hidden" name="packed_state" value="${packed}">
         <button type="submit">Send sign-in link</button>
       </form>`
    );
  });

  // -------------------------------------------------------------
  // POST /authorize/email — user submitted email
  // -------------------------------------------------------------
  app.post('/authorize/email', async (request, reply) => {
    const parsed = AuthorizeForm.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).type('text/html');
      return htmlPage('Error', `<h1>Sign-in error</h1><p>${parsed.error.message}</p>`);
    }

    const { email, packed_state } = parsed.data;
    const state = unpackState(packed_state);
    if (!state) {
      reply.code(400).type('text/html');
      return htmlPage(
        'Session expired',
        `<h1>Session expired</h1>
         <p>Please return to your app and start the sign-in flow again.</p>`
      );
    }

    // Generate magic link via Supabase Admin API. We use generateLink
    // (not signInWithOtp) because we need to control the redirectTo URL.
    const supabase = getSupabaseAdmin();
    const base = getBaseUrl();
    const callbackUrl = `${base}/authorize/callback?packed_state=${encodeURIComponent(packed_state)}`;

    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: callbackUrl },
    });

    // Loud logging so we can debug delivery issues. console.error goes
    // to stderr → Railway deploy logs. Includes the action_link so we
    // can manually click it if SMTP is broken.
    console.error(
      '[audrey-oauth] generateLink result:',
      JSON.stringify({
        email,
        ok: !linkErr,
        error: linkErr?.message ?? null,
        action_link: linkData?.properties?.action_link ?? null,
        hashed_token_present: Boolean(linkData?.properties?.hashed_token),
      })
    );

    // We deliberately DON'T leak whether the email exists. Same response
    // for "user provisioned, link sent" and "user not provisioned".
    // Generate-link errors that aren't "user not found" still bubble.
    if (linkErr && !/not.found|not_found|does not exist/i.test(linkErr.message)) {
      console.error('[audrey-oauth] magic link generation failed:', linkErr.message);
      reply.code(500).type('text/html');
      return htmlPage(
        'Error',
        `<h1>Couldn't send sign-in link</h1>
         <p>Something went wrong on our side. Please try again in a moment.</p>`
      );
    }

    // Empirically, Supabase's admin.generateLink with type='magiclink'
    // does NOT reliably send the email even when SMTP is configured —
    // it generates the link and expects you to send the email yourself
    // via your own provider. We do exactly that: take the action_link
    // from linkData and POST to Resend directly.
    const actionLink = linkData?.properties?.action_link;
    if (actionLink) {
      const sent = await sendMagicLinkEmail({
        to: email,
        actionLink,
      });
      if (!sent.ok) {
        console.error(
          '[audrey-oauth] resend send failed; user will not receive email:',
          sent.error
        );
        // Still show "check email" page — we don't want to leak that send failed.
        // The action_link is in deploy logs for operator fallback.
      } else {
        console.error(
          '[audrey-oauth] resend send succeeded; id:',
          sent.id ?? '(none)'
        );
      }
    }

    reply.type('text/html');
    return htmlPage(
      'Check your email',
      `<h1>Check your email</h1>
       <p>If <strong>${escapeHtml(email)}</strong> is a registered Audrey user, we've sent a sign-in link. Click the link to continue.</p>
       <p class="small">Link expires in 1 hour.</p>`
    );
  });

  // -------------------------------------------------------------
  // GET /authorize/callback — user clicked magic link in email
  // -------------------------------------------------------------
  // Supabase redirects here after email verification. The Supabase
  // access_token / refresh_token are in the URL FRAGMENT (after #),
  // not the query string — so server-side we don't have them.
  // We render a tiny HTML page that reads the fragment client-side
  // and POSTs it to /authorize/exchange.
  app.get('/authorize/callback', async (request, reply) => {
    const parsed = CallbackQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).type('text/html');
      return htmlPage(
        'Error',
        `<h1>Sign-in error</h1>
         <p>Missing required parameters in callback.</p>`
      );
    }
    const { packed_state } = parsed.data;

    reply.type('text/html');
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in...</title></head>
<body>
<p style="font-family: sans-serif; text-align: center; margin-top: 80px;">Signing you in...</p>
<script>
(function() {
  // Parse the URL fragment Supabase appended to this URL
  var hash = window.location.hash.substring(1);
  var params = new URLSearchParams(hash);
  var accessToken = params.get('access_token');
  if (!accessToken) {
    document.body.innerHTML = '<p style="font-family: sans-serif; text-align: center; margin-top: 80px; color: #c00;">Sign-in failed: no access token.</p>';
    return;
  }
  // POST the access_token to the exchange endpoint
  var form = document.createElement('form');
  form.method = 'POST';
  form.action = '/authorize/exchange';
  var inp1 = document.createElement('input');
  inp1.type = 'hidden'; inp1.name = 'access_token'; inp1.value = accessToken;
  form.appendChild(inp1);
  var inp2 = document.createElement('input');
  inp2.type = 'hidden'; inp2.name = 'packed_state'; inp2.value = ${JSON.stringify(packed_state)};
  form.appendChild(inp2);
  document.body.appendChild(form);
  form.submit();
})();
</script>
</body></html>`;
  });

  // -------------------------------------------------------------
  // POST /authorize/exchange — exchange Supabase token for our OAuth code
  // -------------------------------------------------------------
  const ExchangeForm = z.object({
    access_token: z.string().min(1),
    packed_state: z.string().min(1),
  });

  app.post('/authorize/exchange', async (request, reply) => {
    const parsed = ExchangeForm.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).type('text/html');
      return htmlPage('Error', `<h1>Error</h1><p>${parsed.error.message}</p>`);
    }

    const { access_token, packed_state } = parsed.data;
    const state = unpackState(packed_state);
    if (!state) {
      reply.code(400).type('text/html');
      return htmlPage(
        'Session expired',
        `<h1>Session expired</h1><p>Please start the sign-in flow again.</p>`
      );
    }

    // Verify the Supabase token, extract user_id + firm_id
    const supabase = getSupabaseAdmin();
    const { data: userData, error } = await supabase.auth.getUser(access_token);
    if (error || !userData.user) {
      reply.code(401).type('text/html');
      return htmlPage(
        'Sign-in failed',
        `<h1>Sign-in failed</h1>
         <p>Couldn't verify your session. Please try again.</p>`
      );
    }

    const user = userData.user;
    const firmId = (user.app_metadata as Record<string, unknown>)?.firm_id;
    if (typeof firmId !== 'string' || !firmId) {
      reply.code(403).type('text/html');
      return htmlPage(
        'No firm assigned',
        `<h1>No firm assigned</h1>
         <p>Your account isn't associated with a firm. Contact your admin or the person who invited you.</p>`
      );
    }

    // Mint our OAuth code
    const { code } = await oauthRepository.issueCode({
      clientId: state.clientId,
      userId: user.id,
      firmId,
      redirectUri: state.redirectUri,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: state.codeChallengeMethod,
      scope: state.scope,
    });

    // Build redirect back to Claude.ai
    const redirect = new URL(state.redirectUri);
    redirect.searchParams.set('code', code);
    if (state.state) redirect.searchParams.set('state', state.state);

    return reply.redirect(302, redirect.toString());
  });
}

// ============================================================
// Helpers
// ============================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Send magic-link email via Resend (direct REST API).
// We don't rely on Supabase's auth.admin.generateLink to send the
// email — that path has been empirically unreliable. We take the
// action_link from generateLink and send it ourselves.
// ============================================================

interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

async function sendMagicLinkEmail(args: {
  to: string;
  actionLink: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        'RESEND_API_KEY not set in environment — magic-link emails cannot be ' +
        'sent. Add the key in Railway env vars.',
    };
  }

  const fromAddress =
    process.env.RESEND_FROM_EMAIL ?? 'Audrey <audrey-noreply@send.xeqtor.com>';

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">Sign in to Audrey</h1>
  <p style="font-size: 15px; line-height: 1.5; color: #444;">
    You requested a sign-in link for Audrey, your firm's matter intelligence assistant.
    Click the button below to complete sign-in. This link expires in 1 hour and can only be used once.
  </p>
  <p style="margin: 28px 0;">
    <a href="${args.actionLink}" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">Sign in to Audrey</a>
  </p>
  <p style="font-size: 13px; color: #888;">
    If the button doesn't work, copy and paste this URL into your browser:<br>
    <span style="word-break: break-all; color: #666;">${escapeHtml(args.actionLink)}</span>
  </p>
  <hr style="margin: 32px 0; border: none; border-top: 1px solid #eee;">
  <p style="font-size: 12px; color: #999;">
    If you didn't request this, you can safely ignore this email — nothing will happen and no one can sign in to your account.
  </p>
</body></html>`;

  const text =
    `Sign in to Audrey\n\n` +
    `Click this link to complete sign-in:\n${args.actionLink}\n\n` +
    `This link expires in 1 hour and can only be used once.\n\n` +
    `If you didn't request this, you can ignore this email.`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: args.to,
        subject: 'Sign in to Audrey',
        html,
        text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `Resend HTTP ${response.status}: ${body.slice(0, 300)}`,
      };
    }

    const json = (await response.json()) as { id?: string };
    return { ok: true, id: json.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

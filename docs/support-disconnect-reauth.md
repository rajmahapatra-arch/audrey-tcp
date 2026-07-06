# How-to: force-disconnect a user and get them re-authenticated

**Use this when:** a user's Audrey connector is misbehaving (tools
failing, stale auth state, lost/compromised device, or they just can't
get back in) and you want to reset them to a clean sign-in at our end.

**Time to run:** ~2 minutes for you, ~1 minute for the user.

**The one-line summary:** revoke their session server-side (their old
token dies within ~30 seconds), then have them click **Connect** on the
Audrey connector — a fresh magic-link email completes the reissue.

---

## The support script

1. **Revoke** their session (pick a lever below).
2. **Tell the user:**
   > "I've reset your Audrey connection. In Claude, open the **+ menu →
   > Connectors → Audrey** and click **Connect** (on claude.ai web:
   > Settings → Connectors). Then check your email for the Audrey
   > sign-in link and click it. You'll be back in under a minute."
3. **Verify** (optional): ask them to run "Use Audrey to list my
   matters" — a result means the new token works end-to-end.

---

## Lever 1 — admin tool (normal case)

From any of your own Claude surfaces (claude.ai, Desktop, Word,
mobile), in a chat with the Audrey connector enabled:

> Use Audrey's revoke_user_session tool for **anna@firm.com** — reason:
> "support: resetting broken connector state".

Requirements and behaviour:

- Your account must hold role `owner` or `admin` in the firm; the
  target must be a member of the **same firm** (cross-firm revocation
  is deliberately not supported by the tool — see Lever 3).
- Effect: stamps `firm_users.min_token_iat = now()` for the target.
  Their existing JWT is rejected within **~30 seconds** (server cache
  TTL). Their next tool call surfaces the disconnect in Claude.
- The action is audit-logged with your user id and the reason you give.

There is also **`revoke_my_session`** — the self-serve version — if the
user's own session still works well enough to ask their Claude to
"sign out of Audrey".

## Lever 2 — SQL (always works)

Use when the admin tool can't run: your own session is broken too, the
target is in a different firm, or you're doing this from the operator
seat rather than as a firm admin.

Supabase dashboard → SQL editor:

```sql
-- 1. Find the user (confirm you have the right person)
SELECT id, email, created_at FROM auth.users WHERE email = 'anna@firm.com';

-- 2. Revoke: any JWT issued before now() is rejected within ~30s
UPDATE firm_users
SET min_token_iat = now()
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'anna@firm.com');
```

If the user belongs to multiple firms and you only want to reset one,
add `AND firm_id = '<firm-uuid>'` to the UPDATE.

## What "reissue" means (and what we can't do)

We **cannot push a new token into the user's Claude** — in the
connector OAuth model, Anthropic's client initiates the flow. Reissue
is therefore always completed by the user:

1. Claude shows Audrey as disconnected (within ~30s of the revoke, on
   their next tool call or connector refresh).
2. User clicks **Connect** on the Audrey connector.
3. Our server runs the OAuth flow and sends the **magic-link email**
   (sender: Resend, direct API — not Supabase SMTP).
4. User clicks the link → fresh JWT (fresh `iat`, so it passes the
   `min_token_iat` gate) → connector shows connected.

The revoke is what guarantees step 4 issues a genuinely fresh session
rather than resuming broken state.

## Troubleshooting ladder

| Symptom after revoke | Fix |
|---|---|
| User doesn't see a disconnect | Have them send any Audrey request (e.g. "list my matters") or type "refresh connectors" — the rejection surfaces on the next call. |
| Magic-link email doesn't arrive | Check spam; confirm the Resend dashboard shows the send; confirm `RESEND_API_KEY` is set on the server. |
| Email arrives but link lands on an error | Link may be single-use and already clicked, or expired — restart from Connect. |
| Connector stuck showing "This connector doesn't use authentication" and Disconnect greyed out | Known Anthropic-side cached-state bug (hit May 2026). Ladder: try Connect anyway → remove the connector entirely and re-add it with the same URL → if the cache still resurrects the broken state, the last resort is serving the MCP from a fresh hostname (cache is keyed by host — the planned `mcp.audrey.xeqtor.com` custom domain is the permanent fix). |
| Tool list looks stale after reconnect (new tools missing) | A fresh OAuth handshake refreshes the tool catalog; if a surface still shows an old list, fully restart that surface (Claude Desktop: system-tray Quit, check Task Manager, relaunch). |

## Reference facts

- **Revocation propagation:** ≤ ~30 seconds (in-memory `min_token_iat`
  cache TTL on the server).
- **JWT lifetime:** 7 days — the backstop; no session outlives the
  week even if nobody acts.
- **Scope of the admin tool:** per-firm by design. Operator-level
  (cross-firm) resets are SQL-only until ops tooling exists in the
  config UI.
- **Where the mechanism lives:** `firm_users.min_token_iat` column
  (migration 011); tools in `mcp-server/src/tools/sessionTools.ts`;
  cache invalidation in `mcp-server/src/auth.ts`.
- **Self-serve variant:** `revoke_my_session` (any authenticated user,
  own session only).

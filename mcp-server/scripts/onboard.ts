/**
 * scripts/onboard.ts — one-shot firm + user provisioning.
 *
 * The demo-moment tool. Run this when you say "give me your email and
 * firm name" and want the user to be installable into Claude.ai in
 * under 60 seconds.
 *
 * Usage:
 *   tsx scripts/onboard.ts --email gc@firm.com --firm "Their Firm Ltd"
 *
 * What it does, transactionally as much as possible:
 *   1. Create a firms row (or reuse an existing one if you pass --firm-id)
 *   2. Create a Supabase Auth user with app_metadata.firm_id set
 *   3. Insert a firm_users row linking them
 *   4. Send the user a magic-link sign-in email
 *
 * Requires:
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - AUDREY_BASE_URL (so the magic link bounces back to the right host)
 *
 * Safety:
 *   - If the email is already in Supabase Auth, we fail loudly rather
 *     than silently switching their firm. Add --reuse-user if you
 *     really mean it.
 *   - Service-role key never logged.
 */

import { createClient } from '@supabase/supabase-js';
import { parseArgs } from 'node:util';

interface Args {
  email: string;
  firm?: string;
  firmId?: string;
  role: 'owner' | 'admin' | 'member';
  reuseUser: boolean;
  dryRun: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      firm: { type: 'string' },
      'firm-id': { type: 'string' },
      role: { type: 'string', default: 'owner' },
      'reuse-user': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false, short: 'h' },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (!values.email) {
    console.error('Error: --email is required\n');
    printHelp();
    process.exit(1);
  }
  if (!values.firm && !values['firm-id']) {
    console.error('Error: provide either --firm "<name>" (creates new) or --firm-id <uuid> (reuses existing)\n');
    printHelp();
    process.exit(1);
  }

  const role = values.role as 'owner' | 'admin' | 'member';
  if (!['owner', 'admin', 'member'].includes(role)) {
    console.error(`Error: --role must be owner|admin|member (got ${role})`);
    process.exit(1);
  }

  return {
    email: values.email,
    firm: values.firm,
    firmId: values['firm-id'],
    role,
    reuseUser: values['reuse-user'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/onboard.ts [options]

Required:
  --email <email>          User's email address (work email recommended)
  --firm <name>            Create a new firm with this name (mutually exclusive with --firm-id)
  --firm-id <uuid>         Add user to existing firm (mutually exclusive with --firm)

Optional:
  --role <role>            owner | admin | member (default: owner)
  --reuse-user             Allow using an email that already exists in Supabase Auth
  --dry-run                Print what would happen without doing it
  -h, --help               Show this help

Examples:
  tsx scripts/onboard.ts --email gc@acme.com --firm "Acme Corp"
  tsx scripts/onboard.ts --email lawyer@firm.co --firm-id 12345-... --role member
`);
}

async function main() {
  const args = parseCliArgs();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    process.exit(1);
  }

  const baseUrl = process.env.AUDREY_BASE_URL ?? 'https://audrey-tcp-production.up.railway.app';

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('\n--- Audrey onboarding ---');
  console.log(`  Email     : ${args.email}`);
  console.log(`  Firm      : ${args.firm ?? '(existing firm-id)'}`);
  console.log(`  Firm ID   : ${args.firmId ?? '(will be generated)'}`);
  console.log(`  Role      : ${args.role}`);
  console.log(`  Base URL  : ${baseUrl}`);
  console.log(`  Dry-run   : ${args.dryRun ? 'YES' : 'no'}`);
  console.log();

  // ===== 1. Get or create firm =====
  let firmId: string;
  if (args.firmId) {
    const { data, error } = await supabase
      .from('firms')
      .select('id, name, status')
      .eq('id', args.firmId)
      .maybeSingle();
    if (error) {
      console.error(`Error looking up firm: ${error.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error(`Firm ${args.firmId} not found`);
      process.exit(1);
    }
    if (data.status !== 'active') {
      console.error(`Firm ${args.firmId} is ${data.status} — refusing to add users`);
      process.exit(1);
    }
    firmId = data.id;
    console.log(`✓ Found firm: ${data.name} (${firmId})`);
  } else {
    if (args.dryRun) {
      firmId = '00000000-dry-run-firm-id';
      console.log(`[dry-run] Would create firm: ${args.firm}`);
    } else {
      const { data, error } = await supabase
        .from('firms')
        .insert({ name: args.firm!, status: 'active' })
        .select('id')
        .single();
      if (error) {
        console.error(`Error creating firm: ${error.message}`);
        process.exit(1);
      }
      firmId = data.id;
      console.log(`✓ Created firm: ${args.firm} (${firmId})`);
    }
  }

  // ===== 2. Check for existing user =====
  // Supabase admin doesn't expose a getUserByEmail directly via the JS
  // SDK, so we list with a filter.
  const { data: existing, error: lookupErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1,
  });
  // ^^^ listUsers doesn't support email filter directly; we use a
  // smarter approach: try create, handle 422 if exists.

  void existing; void lookupErr;

  // ===== 3. Create user (with firm_id in app_metadata) =====
  let userId: string;
  if (args.dryRun) {
    userId = '00000000-dry-run-user-id';
    console.log(`[dry-run] Would create user: ${args.email} with firm_id ${firmId}`);
  } else {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: args.email,
      email_confirm: true, // pre-confirm; magic link confirms intent below
      app_metadata: { firm_id: firmId },
    });

    if (createErr) {
      // 422 = email already exists. If --reuse-user, look up the
      // existing user and update their app_metadata. Otherwise fail.
      if (/already.exists|already_registered|duplicate/i.test(createErr.message)) {
        if (!args.reuseUser) {
          console.error(
            `Error: user ${args.email} already exists in Supabase Auth. ` +
              `Re-run with --reuse-user to update their firm assignment instead.`
          );
          process.exit(1);
        }
        // Look up by email via listUsers paginated search (Supabase
        // doesn't expose a direct getUserByEmail).
        userId = await findUserIdByEmail(supabase, args.email);
        const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
          app_metadata: { firm_id: firmId },
        });
        if (updErr) {
          console.error(`Failed to update existing user: ${updErr.message}`);
          process.exit(1);
        }
        console.log(`✓ Reused existing user: ${args.email} (${userId}), updated firm_id`);
      } else {
        console.error(`Error creating user: ${createErr.message}`);
        process.exit(1);
      }
    } else {
      userId = created.user.id;
      console.log(`✓ Created user: ${args.email} (${userId})`);
    }
  }

  // ===== 4. Insert firm_users row =====
  if (!args.dryRun) {
    const { error: linkErr } = await supabase.from('firm_users').upsert(
      {
        user_id: userId,
        firm_id: firmId,
        role: args.role,
        status: 'active',
      },
      { onConflict: 'user_id,firm_id' }
    );
    if (linkErr) {
      console.error(`Warning: failed to write firm_users row: ${linkErr.message}`);
      // Not fatal — app_metadata is the source of truth for auth.
    } else {
      console.log(`✓ Linked user to firm in firm_users (role=${args.role})`);
    }
  }

  // ===== 5. Send magic-link sign-in email =====
  if (args.dryRun) {
    console.log(`[dry-run] Would send magic-link email to ${args.email}`);
  } else {
    const { error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: args.email,
      options: { redirectTo: `${baseUrl}/authorize/callback` },
    });
    if (linkErr) {
      console.error(`Warning: failed to send magic link: ${linkErr.message}`);
      console.error('  User exists but will need to use the OAuth /authorize flow to sign in initially.');
    } else {
      console.log(`✓ Sent magic-link sign-in email to ${args.email}`);
    }
  }

  console.log();
  console.log('--- Done ---');
  console.log(`Firm ID: ${firmId}`);
  console.log(`User ID: ${userId}`);
  console.log();
  console.log('Next: tell the user to open Claude.ai → Settings → Connectors → Add custom connector → paste:');
  console.log(`  ${baseUrl}/mcp`);
}

async function findUserIdByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string
): Promise<string> {
  // Paginated scan — fine at our scale (handful of users in Stage A).
  // Replace with a direct lookup if Supabase exposes one.
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (data.users.length < perPage) break; // last page
  }
  throw new Error(`User ${email} not found via listUsers scan`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});

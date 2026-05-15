/**
 * list_matters — discovery tool. Returns a compact list of matters in
 * the firm's workspace, optionally filtered by client, stage, or
 * counterparty.
 *
 * This is intentionally compact: each entry has just enough to let
 * Claude (or the user) pick a matter to drill into via get_matter. We
 * don't want list_matters returning a wall of JSON — that's what
 * get_matter is for.
 *
 * Stage A: reads from mattersRepository.list, which falls back to
 *          stubs when Supabase isn't configured.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mattersRepository } from '../repositories/matters.js';
import type { Matter } from '../types.js';

// ============================================================
// Tool definition (advertised to Claude)
// ============================================================

export const listMattersTool: Tool = {
  name: 'list_matters',
  description:
    'List matters in the current workspace, optionally filtered by client, stage, or ' +
    "counterparty. Returns a compact summary for each matter — use this when the user " +
    "asks broadly (\"what's open?\", \"any matters with Behemoth?\") and follow up with " +
    'get_matter for details.',
  inputSchema: {
    type: 'object',
    properties: {
      client_id: {
        type: 'string',
        description: 'Filter to matters for a specific client (UUID).',
      },
      stage: {
        type: 'string',
        enum: ['pre_draft', 'in_negotiation', 'settled', 'executed', 'closed'],
        description: 'Filter by matter stage.',
      },
      counterparty: {
        type: 'string',
        description:
          'Filter to matters involving a counterparty by name or UUID. Case-insensitive partial match on name.',
      },
    },
  },
};

// ============================================================
// Input validation
// ============================================================

const ListMattersInput = z.object({
  client_id: z.string().uuid().optional(),
  stage: z
    .enum(['pre_draft', 'in_negotiation', 'settled', 'executed', 'closed'])
    .optional(),
  counterparty: z.string().min(1).optional(),
});

// ============================================================
// Output shape — compact summary, NOT the full Matter
// ============================================================

interface MatterSummary {
  id: string;
  matter_name: string | null;
  client_id: string;
  client_name: string | null;
  matter_type: string;
  stage: string;
  opened_at: string;
  counterparties: string[];
  open_position_count: number;
}

function toSummary(m: Matter): MatterSummary {
  return {
    id: m.id,
    matter_name: m.matterName,
    client_id: m.clientId,
    client_name: m.clientName,
    matter_type: m.matterType,
    stage: m.stage,
    opened_at: m.openedAt,
    counterparties: m.parties
      .filter((p) => p.kind === 'counterparty')
      .map((p) => p.partyId),
    open_position_count: m.openPositions.length,
  };
}

// ============================================================
// Handler
// ============================================================

export async function handleListMatters(
  args: unknown,
  firmId: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = ListMattersInput.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid input: ${parsed.error.message}`,
        },
      ],
    };
  }

  const { client_id, stage, counterparty } = parsed.data;

  const matters = await mattersRepository.list(firmId, {
    clientId: client_id,
    status: stage,
    counterparty,
  });

  // Counterparty filter is applied client-side because the underlying
  // schema stores parties as a JSON column — a SQL filter on it lives
  // in a future migration. For Stage A, in-memory filter is fine
  // (typical workspace has <500 matters).
  const filtered = counterparty
    ? matters.filter((m) =>
        m.parties.some(
          (p) =>
            p.kind === 'counterparty' &&
            p.partyId.toLowerCase().includes(counterparty.toLowerCase())
        )
      )
    : matters;

  if (filtered.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No matters match those filters in the current workspace.',
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            count: filtered.length,
            matters: filtered.map(toSummary),
          },
          null,
          2
        ),
      },
    ],
  };
}

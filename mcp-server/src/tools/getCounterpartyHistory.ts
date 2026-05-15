/**
 * get_counterparty_history — the cross-matter intelligence tool.
 *
 * This is the one that demonstrates Audrey's wedge: "we've negotiated
 * with Behemoth six times. Here's where they land on liability caps,
 * IP indemnity, audit rights — with the matter IDs to cite."
 *
 * Stage A: synthesises from matter positions (see counterparties
 *          repository). Returns empty groupings if positions haven't
 *          been extracted yet.
 * Stage B: backed by counterparty_observations table populated by the
 *          position-extraction pipeline.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { counterpartiesRepository } from '../repositories/counterparties.js';

// ============================================================
// Tool definition
// ============================================================

export const getCounterpartyHistoryTool: Tool = {
  name: 'get_counterparty_history',
  description: [
    "Audrey's cross-matter intelligence on a counterparty: every position they've taken",
    'on each clause type, citing the matters where it appeared. This is the wedge tool',
    'lawyers want most. Call this WHENEVER the user is reviewing a counterparty draft,',
    'replying to their markup, or asking what to expect — e.g. "what does Behemoth',
    'typically push on liability caps?", "have we negotiated with KBR before?", "what',
    'positions has ACT accepted on IP indemnity?". Pass the counterparty name',
    '(case-insensitive partial match supported) and optionally a clause_type filter.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      counterparty: {
        type: 'string',
        description:
          'Counterparty name or UUID. Case-insensitive partial match on name is supported.',
      },
      clause_type: {
        type: 'string',
        description:
          'Optional: restrict to a single clause type (e.g. "liability_cap", "ip_indemnity").',
      },
    },
    required: ['counterparty'],
  },
};

// ============================================================
// Input validation
// ============================================================

const Input = z.object({
  counterparty: z.string().min(1),
  clause_type: z.string().min(1).optional(),
});

// ============================================================
// Handler
// ============================================================

export async function handleGetCounterpartyHistory(
  args: unknown,
  firmId: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = Input.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        { type: 'text', text: `Invalid input: ${parsed.error.message}` },
      ],
    };
  }

  const { counterparty, clause_type } = parsed.data;
  const history = await counterpartiesRepository.getHistory(
    firmId,
    counterparty,
    clause_type
  );

  if (history.matter_count === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No prior matters found with ${counterparty} in the current workspace.`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(history, null, 2),
      },
    ],
  };
}

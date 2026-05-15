/**
 * Position tools — get_open_positions, get_settled_positions,
 * get_position_history, add_position.
 *
 * All four share the same firm-scoped read/write pattern against the
 * positions table. Batched in this file to keep registration simple.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { positionsRepository, type Position } from '../repositories/positions.js';
import type { PositionStatus, PartyRole } from '../extraction/extractor.js';

// ============================================================
// Shared output mapper — clean, Claude-friendly shape
// ============================================================

function summarise(p: Position): Record<string, unknown> {
  return {
    id: p.id,
    clause_type: p.clauseType,
    value: p.value,
    status: p.status,
    counterparty: p.counterpartyName,
    party_role: p.partyRole,
    asserted_by: p.extractedBy.startsWith('user:') ? 'user' : 'audrey',
    asserted_at: p.createdAt,
    source_note: p.sourceChunkText,
    confidence: p.confidence,
    superseded: Boolean(p.supersededBy),
  };
}

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s, null, 2) }],
});

// ============================================================
// get_open_positions
// ============================================================

export const getOpenPositionsTool: Tool = {
  name: 'get_open_positions',
  description: [
    "Audrey's view of what's currently OPEN on a matter — clauses still",
    'under negotiation, no agreed value yet. Call this when the user asks',
    '"what\'s open?", "what are we still negotiating?", "what do I need to',
    'close out before signing?". Returns each open position with clause type,',
    'current value, counterparty, and provenance (whether Audrey extracted it',
    'or the lawyer asserted it).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['matter_id'],
    properties: {
      matter_id: { type: 'string', description: 'UUID of the matter.' },
    },
  },
};

const MatterIdInput = z.object({ matter_id: z.string().uuid() });

export async function handleGetOpenPositions(args: unknown, firmId: string) {
  const parsed = MatterIdInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });
  const rows = await positionsRepository.listActive(firmId, parsed.data.matter_id, {
    status: 'open',
  });
  return text({
    matter_id: parsed.data.matter_id,
    count: rows.length,
    positions: rows.map(summarise),
  });
}

// ============================================================
// get_settled_positions
// ============================================================

export const getSettledPositionsTool: Tool = {
  name: 'get_settled_positions',
  description: [
    "Audrey's view of what's been SETTLED on a matter — clauses where both",
    'sides have agreed and are not under further negotiation. Call this',
    'when the user asks "what have we agreed?", "what\'s done?", or when',
    'they want to draft from a base of settled terms. Includes the agreed',
    'value, counterparty, and which side asserted the settlement.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['matter_id'],
    properties: {
      matter_id: { type: 'string', description: 'UUID of the matter.' },
    },
  },
};

export async function handleGetSettledPositions(args: unknown, firmId: string) {
  const parsed = MatterIdInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });
  const rows = await positionsRepository.listActive(firmId, parsed.data.matter_id, {
    status: 'settled',
  });
  return text({
    matter_id: parsed.data.matter_id,
    count: rows.length,
    positions: rows.map(summarise),
  });
}

// ============================================================
// get_position_history
// ============================================================

export const getPositionHistoryTool: Tool = {
  name: 'get_position_history',
  description: [
    'Full audit history of positions on a matter, including superseded',
    'rows, ordered chronologically. This is the "how did we get here?"',
    'view — useful when the user asks "how has the liability cap evolved?",',
    '"when did we agree governing law?", or wants to write a deal summary',
    'showing how positions moved. Optionally filter to a single clause_type.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['matter_id'],
    properties: {
      matter_id: { type: 'string', description: 'UUID of the matter.' },
      clause_type: {
        type: 'string',
        description: 'Optional: restrict to one clause type (e.g. "liability_cap").',
      },
    },
  },
};

const HistoryInput = z.object({
  matter_id: z.string().uuid(),
  clause_type: z.string().optional(),
});

export async function handleGetPositionHistory(args: unknown, firmId: string) {
  const parsed = HistoryInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });
  const rows = await positionsRepository.listHistory(firmId, parsed.data.matter_id, {
    clauseType: parsed.data.clause_type,
  });
  return text({
    matter_id: parsed.data.matter_id,
    clause_type: parsed.data.clause_type ?? null,
    count: rows.length,
    history: rows.map(summarise),
  });
}

// ============================================================
// add_position (the lawyer-commit path)
// ============================================================

export const addPositionTool: Tool = {
  name: 'add_position',
  description: [
    'Record a position the lawyer has decided or learned about — the manual',
    'commit path into Audrey\'s memory. Use this when the user explicitly',
    'states a position, e.g. "record that KBR has agreed to a 12-month',
    'liability cap on the ADNOC matter" or "we\'ve decided to push back on',
    'the IP indemnity scope". This INSERTS a new position row. If a',
    'previous position exists for the same (matter, clause_type), it is',
    'automatically superseded — the history is preserved.',
    '',
    'Stamped with the user\'s id, confidence 1.0 (user-asserted), and the',
    'source_note field if the user mentions a basis (e.g. "call with KBR',
    '2026-05-14"). Audit-logged.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['matter_id', 'clause_type', 'value', 'status'],
    properties: {
      matter_id: { type: 'string', description: 'UUID of the matter.' },
      clause_type: {
        type: 'string',
        description:
          'Canonical snake_case clause id, e.g. "liability_cap", "ip_indemnity", ' +
          '"governing_law". Use one Audrey already knows about if possible.',
      },
      value: {
        type: 'object',
        description:
          'Structured value, e.g. {amount: "12 months fees"} or ' +
          '{jurisdiction: "England and Wales"} or {scope: "unlimited"}.',
        additionalProperties: true,
      },
      status: {
        type: 'string',
        enum: ['proposed', 'open', 'settled', 'rejected'],
        description:
          '"settled" when both sides have agreed; "open" when under negotiation; ' +
          '"proposed" when one side has put it forward but no response; ' +
          '"rejected" when explicitly refused.',
      },
      counterparty_name: {
        type: 'string',
        description: 'Counterparty name if relevant, e.g. "KBR".',
      },
      party_role: {
        type: 'string',
        enum: ['our_side', 'counterparty', 'neutral', 'mutual'],
        description:
          'Whose position this is. "mutual" for symmetric agreements; ' +
          '"neutral" for structural clauses like governing_law.',
      },
      source_note: {
        type: 'string',
        description:
          'Optional free-text note explaining the basis — e.g. "Confirmed on ' +
          'call with KBR 2026-05-14" or "Per email from counsel".',
      },
    },
  },
};

const AddPositionInput = z.object({
  matter_id: z.string().uuid(),
  clause_type: z.string().min(1),
  value: z.record(z.unknown()),
  status: z.enum(['proposed', 'open', 'settled', 'rejected']),
  counterparty_name: z.string().min(1).optional(),
  party_role: z.enum(['our_side', 'counterparty', 'neutral', 'mutual']).optional(),
  source_note: z.string().optional(),
});

export async function handleAddPosition(args: unknown, firmId: string, userId: string | null) {
  const parsed = AddPositionInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });

  if (!userId) {
    return text({
      error: 'authenticated user required to assert a position; no user_id resolved from the request',
    });
  }

  const inserted = await positionsRepository.assertByUser({
    firmId,
    userId,
    matterId: parsed.data.matter_id,
    clauseType: parsed.data.clause_type,
    value: parsed.data.value,
    status: parsed.data.status as PositionStatus,
    counterpartyName: parsed.data.counterparty_name ?? null,
    partyRole: (parsed.data.party_role as PartyRole | undefined) ?? null,
    sourceChunkText: parsed.data.source_note ?? null,
    sourceDocumentId: null,
  });

  return text({
    result: 'recorded',
    position: summarise(inserted),
    message:
      'Position recorded in Audrey. Any prior position for this clause type on this matter ' +
      'has been superseded. The history remains visible via get_position_history.',
  });
}

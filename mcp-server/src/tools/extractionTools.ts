/**
 * audrey_check_draft + search_matter_text.
 *
 * Both expose extraction-pipeline machinery to Claude:
 *   - check_draft runs extraction synchronously without persisting.
 *     Use case: lawyer wants to know "what positions are in this draft
 *     I'm about to send?" without committing them to Audrey's memory.
 *   - search_matter_text embeds a query and vector-searches matter
 *     content. Use case: lawyer asks free-text questions Audrey can't
 *     answer structurally ("find anywhere we discussed 60-day cure
 *     windows").
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { extractPositions } from '../extraction/extractor.js';
import { embedBatch } from '../extraction/embedder.js';
import { matterMemoryRepository } from '../repositories/matterMemory.js';
import { mattersRepository } from '../repositories/matters.js';

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

// ============================================================
// audrey_check_draft
// ============================================================

export const audreyCheckDraftTool: Tool = {
  name: 'audrey_check_draft',
  description:
    'Preview position extraction on draft text without saving anything. Pass matter_id ' +
    "to also flag deviations from that matter's settled positions. No DB writes.",
  inputSchema: {
    type: 'object',
    required: ['document_text'],
    properties: {
      document_text: {
        type: 'string',
        description:
          'The full text of the draft to analyse. Pass the body of the open Word document.',
      },
      matter_id: {
        type: 'string',
        description:
          'Optional UUID of the matter this draft relates to. When provided, the response ' +
          'includes a comparison against the matter\'s settled positions, flagging deviations.',
      },
    },
  },
};

const CheckDraftInput = z.object({
  document_text: z.string().min(50),
  matter_id: z.string().uuid().optional(),
});

export async function handleAudreyCheckDraft(args: unknown, firmId: string) {
  const parsed = CheckDraftInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });

  // Optional matter context (helps the extractor disambiguate parties)
  let matterName: string | null = null;
  let clientName: string | null = null;
  if (parsed.data.matter_id) {
    const matter = await mattersRepository.findById(firmId, parsed.data.matter_id);
    if (matter) {
      matterName = matter.matterName;
      clientName = matter.clientName;
    }
  }

  const result = await extractPositions(parsed.data.document_text, {
    matterName,
    clientName,
    ourSide: clientName,
  });

  return text({
    result: 'preview',
    matter_id: parsed.data.matter_id ?? null,
    matter_name: matterName,
    positions_detected: result.positions.length,
    positions: result.positions,
    note:
      'This is a preview only — nothing has been saved to Audrey. Use add_position ' +
      'to commit any of these, or upload the document for full automatic intake.',
    usage: result.usage,
  });
}

// ============================================================
// search_matter_text
// ============================================================

export const searchMatterTextTool: Tool = {
  name: 'search_matter_text',
  description:
    'Semantic search across stored documents and matter memories, for open-ended recall ' +
    '("anywhere we discussed 60-day cure windows?"). Prefer the structured position tools ' +
    'for structured questions. Optional matter_id scope.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description:
          'The natural-language search query. Audrey embeds this and finds the most ' +
          'semantically similar excerpts.',
      },
      matter_id: {
        type: 'string',
        description: 'Optional UUID — restrict the search to one matter\'s content.',
      },
      limit: {
        type: 'number',
        description: 'Max excerpts to return (default 8, max 20).',
      },
    },
  },
};

const SearchInput = z.object({
  query: z.string().min(3),
  matter_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export async function handleSearchMatterText(args: unknown, firmId: string) {
  const parsed = SearchInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });

  // 1. Embed the query
  const [queryEmb] = await embedBatch([parsed.data.query]);
  if (!queryEmb || !queryEmb.embedding) {
    return text({
      error:
        'Failed to embed search query — Audrey could not generate a vector for it. ' +
        'Try again or use a different phrasing.',
    });
  }

  // 2. Vector search
  const matches = await matterMemoryRepository.searchByEmbedding({
    firmId,
    queryEmbedding: queryEmb.embedding,
    matterId: parsed.data.matter_id,
    limit: parsed.data.limit ?? 8,
  });

  if (matches.length === 0) {
    return text({
      result: 'no_matches',
      message:
        'No matter content matched the query. Either Audrey has no embedded text yet ' +
        '(check if extraction has run on relevant documents) or this concept does not ' +
        "appear in the firm's history.",
    });
  }

  return text({
    result: 'matches',
    query: parsed.data.query,
    matter_id_filter: parsed.data.matter_id ?? null,
    count: matches.length,
    matches: matches.map((m) => ({
      matter_id: m.matterId,
      excerpt: m.content,
      memory_type: m.memoryType,
      source_document_id: m.sourceDocumentId,
      similarity: m.distance !== undefined ? Math.max(0, 1 - m.distance) : null,
      created_at: m.createdAt,
    })),
  });
}

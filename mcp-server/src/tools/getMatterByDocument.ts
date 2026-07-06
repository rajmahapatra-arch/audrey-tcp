/**
 * get_matter_by_document — find the matter a given Word document belongs to.
 *
 * This is the most important tool for the Claude-in-Word UX. When a
 * lawyer has a document open and asks Claude anything about it,
 * Claude's first call should be this tool. It resolves the document
 * to a matter (and surfaces precedent/loose status), giving Claude
 * the firm context needed to answer well.
 *
 * Resolution order (tried in sequence, first hit wins):
 *   1. word_doc_id   — Office's stable per-document identifier. Most
 *                      reliable but only Claude in Word can supply it.
 *   2. document_name — filename match against documents.name. Good
 *                      when the doc has been ingested into Audrey
 *                      previously.
 *   3. content_snippet — fuzzy match against matter_name, useful when
 *                        only doc title or a defined-term is known.
 *
 * Output shapes (one of):
 *   - matched (exact / fuzzy): Audrey identified the matter; full
 *     matter summary returned plus any alternatives Claude can offer.
 *   - precedent_only: doc exists in Audrey as a precedent (client
 *     standard form), not yet placed in any specific matter. Claude
 *     should offer to place it.
 *   - unknown: no match at all. Claude should ask the user to clarify
 *     which matter this belongs to, or list_matters to choose.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mattersRepository } from '../repositories/matters.js';
import type { Matter } from '../types.js';

// ============================================================
// Tool definition (directive descriptions — Audrey-branded)
// ============================================================

export const getMatterByDocumentTool: Tool = {
  name: 'get_matter_by_document',
  description:
    'Resolve an open document to its Audrey matter — call this first whenever the user is ' +
    'working in a document. Matches by Office ID, filename, and content (party/client names ' +
    'in the snippet help a lot); returns the matter summary with confidence and alternatives, ' +
    'or a precedent/unknown status.',
  inputSchema: {
    type: 'object',
    required: ['document_name'],
    properties: {
      document_name: {
        type: 'string',
        description: 'Filename of the open document, e.g. "KBR_ADNOC_v4.docx". Always available — required.',
      },
      word_doc_id: {
        type: 'string',
        description: "Office's stable document identifier when available (context.document.url). Most precise.",
      },
      content_snippet: {
        type: 'string',
        description:
          'First ~300 characters of the document INCLUDING the party names from the ' +
          'recitals — enables matching by client and matter name. Strongly recommended.',
      },
    },
  },
};

// ============================================================
// Input validation
// ============================================================

const Input = z.object({
  document_name: z.string().min(1),
  word_doc_id: z.string().min(1).optional(),
  content_snippet: z.string().min(3).optional(),
});

// ============================================================
// Output mapping
// ============================================================

function matterSummary(m: Matter) {
  return {
    id: m.id,
    matter_name: m.matterName,
    client_id: m.clientId,
    client_name: m.clientName,
    stage: m.stage,
    matter_type: m.matterType,
    opened_at: m.openedAt,
    closed_at: m.closedAt,
    counterparty_count: m.parties.filter((p) => p.kind === 'counterparty').length,
    settled_position_count: m.settledPositions.length,
    open_position_count: m.openPositions.length,
  };
}

// ============================================================
// Handler
// ============================================================

export async function handleGetMatterByDocument(
  args: unknown,
  firmId: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = Input.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }],
    };
  }

  const { word_doc_id, document_name, content_snippet } = parsed.data;
  const result = await mattersRepository.findByDocument(firmId, {
    wordDocId: word_doc_id,
    documentName: document_name,
    contentSnippet: content_snippet,
  });

  // === Precedent (document recognised but not placed in any matter) ===
  if (
    result.document?.isPrecedent &&
    !result.matter
  ) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            result: 'precedent_only',
            document: {
              id: result.document.id,
              name: result.document.name,
              word_doc_id: result.document.wordDocId,
              is_precedent: true,
            },
            message:
              'Known precedent, not placed in a matter. Offer to place it (list_matters to choose).',
          }),
        },
      ],
    };
  }

  // === No match at all ===
  if (!result.matter && result.alternatives.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            result: 'unknown',
            message:
              'No matter linked to this document. Ask the user which matter it belongs to ' +
              '(or list_matters), then offer to place it.',
          }),
        },
      ],
    };
  }

  // === Matched (exact or fuzzy) ===
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          result: 'matched',
          confidence: result.confidence,
          matter: result.matter ? matterSummary(result.matter) : null,
          document: result.document
            ? {
                id: result.document.id,
                name: result.document.name,
                word_doc_id: result.document.wordDocId,
                is_precedent: result.document.isPrecedent,
              }
            : null,
          alternatives: result.alternatives.map(matterSummary),
          message:
            result.confidence === 'exact'
              ? 'Matter identified with high confidence.'
              : 'Best fuzzy match — confirm with the user if it looks wrong.',
        }),
      },
    ],
  };
}

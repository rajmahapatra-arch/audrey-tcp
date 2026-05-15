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
    'Resolve the open Word document to a matter in Audrey. **WHENEVER the user has a ' +
    "document open and asks ANY question about it, this MUST be your first call** — before " +
    "answering, before reading the document content, before any other Audrey tool. It " +
    'returns matter context (parties, stage, settled positions, counterparty history pointer) ' +
    "so your answers are grounded in the firm's prior negotiation and not just what's on the " +
    'page. Pass any combination of word_doc_id (preferred — Office gives you this), ' +
    'document_name (the filename), or content_snippet (a defined-term or first-line excerpt). ' +
    "If the document is a client standard form not yet placed in a matter, the response " +
    "will say so and you should offer the user the option to place it.",
  inputSchema: {
    type: 'object',
    properties: {
      word_doc_id: {
        type: 'string',
        description:
          "Office's stable document identifier (preferred). Word's add-in API gives you this " +
          'via context.document.url or document.id.',
      },
      document_name: {
        type: 'string',
        description:
          'Filename of the open document, e.g. "KBR_ADNOC_v4.docx". Extension and version ' +
          'suffixes are stripped automatically.',
      },
      content_snippet: {
        type: 'string',
        description:
          'A distinctive phrase or defined term from the document — e.g. the matter title ' +
          'from the doc header, or the names of the parties as written in the recitals. ' +
          'Used as a fallback when neither word_doc_id nor document_name is available.',
      },
    },
  },
};

// ============================================================
// Input validation
// ============================================================

const Input = z.object({
  word_doc_id: z.string().min(1).optional(),
  document_name: z.string().min(1).optional(),
  content_snippet: z.string().min(3).optional(),
}).refine(
  (v) => v.word_doc_id || v.document_name || v.content_snippet,
  { message: 'At least one of word_doc_id, document_name, content_snippet is required' }
);

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
          text: JSON.stringify(
            {
              result: 'precedent_only',
              document: {
                id: result.document.id,
                name: result.document.name,
                word_doc_id: result.document.wordDocId,
                is_precedent: true,
              },
              message:
                'This document is a precedent (client standard form) in Audrey, not yet ' +
                'placed in a specific matter. Offer the user the option to place it in an ' +
                'existing matter (list_matters to choose) or start a new matter.',
            },
            null,
            2
          ),
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
          text: JSON.stringify(
            {
              result: 'unknown',
              message:
                'Audrey does not have this document linked to any matter yet. Either it ' +
                "hasn't been ingested, or the hint provided doesn't match anything. Ask " +
                'the user which matter this belongs to, or call list_matters for them to ' +
                'choose. If they decide on a matter, you can place this document in it.',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // === Matched (exact or fuzzy) ===
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
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
                ? 'Matter identified with high confidence. Use this context when answering.'
                : "Best fuzzy match — if this doesn't look right, check the alternatives or " +
                  'ask the user to confirm.',
          },
          null,
          2
        ),
      },
    ],
  };
}

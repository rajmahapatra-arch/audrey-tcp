/**
 * get_matter — returns curated state for a single matter.
 *
 * Stage A: returns hardcoded stub data for development. Stage B replaces
 * the body with a call to mattersRepository.findById(firmId, matterId).
 *
 * Tool handler discipline:
 *   - All data access goes through repositories (see ../repositories/).
 *   - firmId is passed in from the request context (currently stubbed).
 *   - Errors are typed; never expose internal stack traces to the caller.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mattersRepository } from '../repositories/matters.js';

// ============================================================
// Tool definition (advertised to Claude)
// ============================================================

export const getMatterTool: Tool = {
  name: 'get_matter',
  description:
    "Audrey's full curated state for a single matter: parties, current draft, open " +
    "issues, settled positions, key dates, deal stage. Call this AFTER you have a matter " +
    'ID — typically resolved via get_matter_by_document (when the user has a doc open) or ' +
    'list_matters (when the user is browsing). Your answers to any matter-specific question ' +
    "MUST be grounded in what this tool returns rather than the document content alone — " +
    "the document is just the latest draft; Audrey holds the firm's institutional memory of " +
    'the deal.',
  inputSchema: {
    type: 'object',
    properties: {
      matter_id: {
        type: 'string',
        description: 'UUID of the matter to retrieve.',
      },
    },
    required: ['matter_id'],
  },
};

// ============================================================
// Input validation
// ============================================================

const GetMatterInput = z.object({
  matter_id: z.string().uuid(),
});

// ============================================================
// Handler
// ============================================================

export async function handleGetMatter(
  args: unknown,
  firmId: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const parsed = GetMatterInput.safeParse(args);
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

  const { matter_id } = parsed.data;
  const matter = await mattersRepository.findById(firmId, matter_id);

  if (!matter) {
    return {
      content: [
        {
          type: 'text',
          text: `No matter found with id ${matter_id} in the current workspace.`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(matter, null, 2),
      },
    ],
  };
}

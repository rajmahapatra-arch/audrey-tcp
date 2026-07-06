/**
 * add_matter_note — the phone-capture path into matter memory.
 *
 * The two-surfaces flow: the lawyer drafts in the Audrey App, but
 * thoughts arrive anywhere — on the train via Claude mobile, in
 * Claude Desktop, mid-conversation in Claude for Word. Positions have
 * add_position; this tool is for everything that ISN'T a clause
 * position: instructions to self, negotiation hunches, follow-ups,
 * observations about the other side.
 *
 * Notes land in matter_memory with status='pending', which is exactly
 * what the Audrey App's LearnedMemories panel surfaces for curation
 * (endorse / dismiss / retire). They're embedded at write time so
 * search_matter_text finds them immediately on every surface.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { matterMemoryRepository } from '../repositories/matterMemory.js';
import { mattersRepository } from '../repositories/matters.js';
import { embedBatch, EMBEDDING_MODEL } from '../extraction/embedder.js';

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

export const addMatterNoteTool: Tool = {
  name: 'add_matter_note',
  description:
    'Capture a thought, instruction, or observation against a matter, from any surface ' +
    '("note on the Elion NDA: push back harder on the IP carve-out"). Saved as a pending ' +
    'memory the lawyer curates in the Audrey App, and immediately searchable via ' +
    'search_matter_text. For concrete clause positions use add_position instead.',
  inputSchema: {
    type: 'object',
    required: ['matter_id', 'note'],
    properties: {
      matter_id: {
        type: 'string',
        description: 'UUID of the matter (resolve via get_matter_by_document or list_matters).',
      },
      note: {
        type: 'string',
        description: "The thought, in the user's own terms. Keep names and specifics.",
      },
      note_type: {
        type: 'string',
        enum: ['decision', 'preference', 'context'],
        description:
          'decision = something resolved; preference = how the client/user likes things; ' +
          'context = background/follow-up (default).',
      },
      scope: {
        type: 'string',
        enum: ['matter', 'client'],
        description:
          '"client" when the note applies to the client across all their matters ' +
          '(e.g. "Elion always wants board-consent carve-outs"). Default "matter".',
      },
    },
  },
};

const Input = z.object({
  matter_id: z.string().uuid(),
  note: z.string().min(3).max(4000),
  note_type: z.enum(['decision', 'preference', 'context']).optional(),
  scope: z.enum(['matter', 'client']).optional(),
});

export async function handleAddMatterNote(args: unknown, firmId: string) {
  const parsed = Input.safeParse(args);
  if (!parsed.success) {
    return text({ error: parsed.error.message });
  }

  // Validate the matter exists in this firm (and pick up its name for
  // a human confirmation the model can echo).
  const matter = await mattersRepository.findById(firmId, parsed.data.matter_id);
  if (!matter) {
    return text({
      error: `Matter ${parsed.data.matter_id} not found in this firm. Use list_matters.`,
    });
  }

  // Embed at write time so the note is instantly searchable. Fail
  // open: a note without an embedding is still a saved note.
  let embedding: number[] | null = null;
  try {
    const [result] = await embedBatch([parsed.data.note]);
    embedding = result?.embedding ?? null;
  } catch (err) {
    console.error(
      '[audrey-note] embedding failed, saving note without one:',
      err instanceof Error ? err.message : String(err)
    );
  }

  const saved = await matterMemoryRepository.addNote({
    firmId,
    matterId: parsed.data.matter_id,
    content: parsed.data.note,
    memoryType: parsed.data.note_type ?? 'context',
    scope: parsed.data.scope ?? 'matter',
    embedding,
    embeddingModel: EMBEDDING_MODEL,
  });

  return text({
    result: 'saved',
    note_id: saved.id,
    matter_name: matter.matterName,
    status: 'pending',
    searchable: embedding !== null,
    message: `Noted on ${matter.matterName ?? 'the matter'} — will appear for curation in the Audrey App.`,
  });
}

/**
 * create_client / create_matter — open new work from any Claude surface
 * ("open a matter for Let's Think, counterparty Weightmans, in
 * negotiation"), so a Claude Project can be pointed at Audrey without a
 * round trip to the Word pane.
 *
 * Both are find-or-create: an existing client or matter (matched
 * ignoring case, punctuation and company suffixes) is returned rather
 * than duplicated, with `created: false` so the model can say so.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { clientsRepository, normaliseName } from '../repositories/clients.js';
import { mattersRepository } from '../repositories/matters.js';
import type { MatterStage } from '../types.js';

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

const STAGES = ['pre_draft', 'in_negotiation', 'settled', 'executed', 'closed'] as const;

export const createClientTool: Tool = {
  name: 'create_client',
  description:
    'Add a client to Audrey. Only when the user asks for a new client (or a new matter ' +
    'for a client that does not exist yet — create_matter does this itself). If the ' +
    'client already exists (ignoring case, punctuation and Ltd/Limited/LLP) the existing ' +
    'one is returned, never a duplicate.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Client name as the user gives it, e.g. "Let\'s Think Limited".' },
    },
  },
};

export const createMatterTool: Tool = {
  name: 'create_matter',
  description:
    'Open a new matter in Audrey, from any surface ("create a Let\'s Think matter"). Only ' +
    'when the user asks. Creates the client too if it is new. If a matter with the same ' +
    'name already exists for that client it is returned instead of a duplicate. Returns ' +
    'the matter_id for upload_document, add_position and add_matter_note. Confirm the ' +
    'client, matter name and counterparty with the user if they are not clear from the request.',
  inputSchema: {
    type: 'object',
    required: ['matter_name'],
    properties: {
      matter_name: {
        type: 'string',
        description: 'Short name the lawyer will recognise, e.g. "Let\'s Think – Weightmans services agreement".',
      },
      client_name: {
        type: 'string',
        description: 'Client name (found or created). Give this or client_id.',
      },
      client_id: { type: 'string', description: 'UUID of an existing client, if known.' },
      counterparty: {
        type: 'string',
        description: 'The other side (company or its law firm). Several may be comma-separated.',
      },
      stage: { type: 'string', enum: [...STAGES], description: 'Matter stage; omit if unknown.' },
      governing_law: { type: 'string', description: 'e.g. "England and Wales", if known.' },
      matter_type: { type: 'string', description: 'e.g. "services agreement", "NDA", if known.' },
    },
  },
};

const ClientInput = z.object({ name: z.string().trim().min(2).max(200) });

const MatterInput = z
  .object({
    matter_name: z.string().trim().min(2).max(200),
    client_name: z.string().trim().min(2).max(200).optional(),
    client_id: z.string().uuid().optional(),
    counterparty: z.string().trim().max(500).optional(),
    stage: z.enum(STAGES).optional(),
    governing_law: z.string().trim().max(200).optional(),
    matter_type: z.string().trim().max(100).optional(),
  })
  .refine((v) => v.client_name || v.client_id, { message: 'Give client_name or client_id.' });

export async function handleCreateClient(args: unknown, firmId: string) {
  const parsed = ClientInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });

  const existing = await clientsRepository.findByName(firmId, parsed.data.name);
  if (existing) {
    return text({
      result: 'exists',
      created: false,
      client_id: existing.id,
      client_name: existing.name,
      message: `"${existing.name}" is already a client in Audrey — using it.`,
    });
  }

  const client = await clientsRepository.create(firmId, parsed.data.name);
  return text({
    result: 'created',
    created: true,
    client_id: client.id,
    client_name: client.name,
    message: `Added client "${client.name}" to Audrey.`,
  });
}

export async function handleCreateMatter(args: unknown, firmId: string, userId: string | null) {
  const parsed = MatterInput.safeParse(args);
  if (!parsed.success) return text({ error: parsed.error.message });
  const input = parsed.data;

  let client = input.client_id ? await clientsRepository.findById(firmId, input.client_id) : null;
  if (input.client_id && !client) {
    return text({ error: `Client ${input.client_id} not found in this firm. Use list_matters, or pass client_name.` });
  }
  let clientCreated = false;
  if (!client && input.client_name) {
    client = await clientsRepository.findByName(firmId, input.client_name);
    if (!client) {
      client = await clientsRepository.create(firmId, input.client_name);
      clientCreated = true;
    }
  }
  if (!client) return text({ error: 'Could not resolve the client.' });

  const wanted = normaliseName(input.matter_name);
  const existing = (await mattersRepository.listForClient(firmId, client.id)).find(
    (m) => normaliseName(m.matterName ?? '') === wanted
  );
  if (existing) {
    return text({
      result: 'exists',
      created: false,
      matter_id: existing.id,
      matter_name: existing.matterName,
      client_name: client.name,
      stage: existing.stage,
      message: `"${existing.matterName}" already exists for ${client.name} — using it.`,
    });
  }

  const counterparties = (input.counterparty ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const matter = await mattersRepository.create(firmId, {
    clientId: client.id,
    clientName: client.name,
    matterName: input.matter_name,
    counterparties,
    stage: (input.stage as MatterStage | undefined) ?? null,
    governingLaw: input.governing_law ?? null,
    matterType: input.matter_type ?? null,
    userId,
  });

  return text({
    result: 'created',
    created: true,
    matter_id: matter.id,
    matter_name: matter.matterName,
    client_id: client.id,
    client_name: client.name,
    client_created: clientCreated,
    counterparties,
    stage: input.stage ?? null,
    message:
      `Opened "${matter.matterName}" for ${client.name}` +
      (clientCreated ? ' (new client)' : '') +
      '. It now appears in the Audrey pane in Word.',
  });
}

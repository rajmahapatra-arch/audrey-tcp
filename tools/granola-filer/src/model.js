// Optional model classifier (rule d).
//
// Interface: classify({ title, attendeeDomains, summaryExcerpt, folders })
//   -> { client, matter, newMatterName?, path, confidence }
//
// Providers:
//   "none"   -- off (default). createClassifier returns null and rule d is skipped.
//   "ollama" -- a local Ollama server (http://127.0.0.1:11434). Output is constrained
//               with a JSON schema. Runs entirely on this laptop: nothing leaves the machine.
//
// Safety: the model can only pick an existing client folder. It may propose a NEW matter
// folder, but only inside an existing client. It can never create a client folder.

import path from 'node:path';
import { sanitiseTitle } from './format.js';
import { norm } from './folders.js';

export const CLIENT_LEVEL = '(client level)';
export const NEW_MATTER = '(new matter)';

export function classificationSchema(folders) {
  const matters = [...new Set(folders.flatMap((c) => c.matters.map((m) => m.name)))];
  return {
    type: 'object',
    properties: {
      client: { type: 'string', enum: folders.map((c) => c.name) },
      matter: { type: 'string', enum: [CLIENT_LEVEL, NEW_MATTER, ...matters] },
      new_matter_name: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['client', 'matter', 'confidence'],
  };
}

export function buildPrompt({ title, attendeeDomains, summaryExcerpt, folders }) {
  const tree = folders.map((c) => `- ${c.name}\n${c.matters.map((m) => `    - ${m.name}`).join('\n')}`).join('\n');
  return [
    'You file a lawyer\'s meeting notes into his client/matter folders.',
    'Pick the client folder and the matter folder the meeting belongs to.',
    `Use "${CLIENT_LEVEL}" if it concerns the client generally rather than one matter.`,
    `Use "${NEW_MATTER}" with new_matter_name only if it is clearly a new piece of work for an existing client.`,
    'Give a confidence between 0 and 1. Be conservative: if unsure, give a low confidence.',
    '',
    'Folders:',
    tree,
    '',
    `Meeting title: ${title || '(none)'}`,
    `Attendee e-mail domains: ${attendeeDomains.join(', ') || '(none)'}`,
    'Summary excerpt:',
    summaryExcerpt || '(none)',
  ].join('\n');
}

/** Validate a raw model answer against the real folders. Returns null if unusable. */
export function validateAnswer(raw, folders) {
  if (!raw || typeof raw !== 'object') return null;
  const client = folders.find((c) => c.name === raw.client) || folders.find((c) => norm(c.name) === norm(raw.client));
  if (!client) return null; // never invent clients
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const answer = { client: client.name, matter: null, confidence };
  if (raw.matter === NEW_MATTER) {
    const name = sanitiseTitle(raw.new_matter_name || '', 60);
    if (!raw.new_matter_name || name === 'Untitled meeting') return { ...answer, confidence: Math.min(confidence, 0.5) };
    const existing = client.matters.find((m) => norm(m.name) === norm(name));
    if (existing) answer.matter = existing.name;
    else answer.newMatterName = name;
  } else if (raw.matter && raw.matter !== CLIENT_LEVEL) {
    const m = client.matters.find((x) => x.name === raw.matter) || client.matters.find((x) => norm(x.name) === norm(raw.matter));
    if (!m) return { ...answer, confidence: Math.min(confidence, 0.5) }; // matter from another client: treat as unsure
    answer.matter = m.name;
  }
  answer.path = path.join(client.path, answer.matter || answer.newMatterName || '');
  return answer;
}

export class OllamaClassifier {
  constructor({ url = 'http://127.0.0.1:11434', model, timeoutMs = 120000, fetchFn = fetch } = {}) {
    this.name = `ollama:${model}`;
    this.url = url.replace(/\/$/, '');
    // Meeting excerpts are confidential: only ever send them to a model on this machine.
    const host = new URL(this.url).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
      throw new Error('The Ollama URL must be on this computer (127.0.0.1)');
    }
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchFn;
  }

  async classify(input) {
    const body = {
      model: this.model,
      stream: false,
      format: classificationSchema(input.folders),
      options: { temperature: 0 },
      messages: [{ role: 'user', content: buildPrompt(input) }],
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
      const j = await r.json();
      const content = j?.message?.content;
      let raw;
      try { raw = JSON.parse(content); } catch { throw new Error('Ollama returned non-JSON output'); }
      return validateAnswer(raw, input.folders);
    } finally {
      clearTimeout(t);
    }
  }
}

export function createClassifier(config) {
  const m = config.model || {};
  if (!m.provider || m.provider === 'none') return null;
  if (m.provider === 'ollama') return new OllamaClassifier(m.ollama || {});
  throw new Error(`Unknown model provider "${m.provider}"`);
}

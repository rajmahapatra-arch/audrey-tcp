// Granola tool calls. Arguments are built from the live tool schemas (tools/list), so
// small schema changes on Granola's side degrade gracefully. Schemas as discovered on
// 2026-10-29 are recorded in NOTES.md.

import { parseFolders, parseMeetings, parseTranscript, nextCursor } from './parse.js';

const props = (schema) => schema?.inputSchema?.properties || {};
const has = (p, k) => Object.prototype.hasOwnProperty.call(p, k);
const keyMatching = (p, re, type) => Object.keys(p).find((k) => re.test(k) && (!type || [].concat(p[k].type || []).includes(type) || !p[k].type));

/** Local calendar date YYYY-MM-DD (Granola reads offsetless dates in the user's timezone). */
export const ymdLocalDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Build list_meetings arguments for a date window (and optional folder) from its schema. */
export function buildListArgs(schema, { from, to, folderId, cursor }) {
  const p = props(schema);
  const args = {};
  const startKey = ['from_date', 'start_date', 'custom_start'].find((k) => has(p, k))
    || keyMatching(p, /start|from|after|since/i, 'string');
  const endKey = ['to_date', 'end_date', 'custom_end'].find((k) => has(p, k))
    || keyMatching(p, /end|before|until/i, 'string');
  const rangeKey = Object.keys(p).find((k) => /range|period|window/i.test(k) && Array.isArray(p[k].enum));
  if (rangeKey && startKey) {
    const custom = p[rangeKey].enum.find((v) => /custom/i.test(v));
    if (custom) args[rangeKey] = custom;
  }
  if (startKey) args[startKey] = ymdLocalDate(from);
  if (endKey) args[endKey] = ymdLocalDate(to);
  const limitKey = keyMatching(p, /^(limit|page_?size|max(_?results)?)$/i);
  if (limitKey) args[limitKey] = Math.min(p[limitKey].maximum ?? 100, 100);
  if (folderId) {
    const fk = keyMatching(p, /folder/i);
    if (fk) args[fk] = p[fk].type === 'array' ? [folderId] : folderId;
  }
  if (cursor) {
    const ck = keyMatching(p, /cursor|page_?token/i);
    if (ck) args[ck] = cursor;
  }
  return args;
}

export function listSupportsFolder(schema) {
  return !!keyMatching(props(schema), /folder/i);
}

/** How to pass meeting IDs to get_meetings: {make(chunk), max}. */
export function idArgs(schema) {
  const p = props(schema);
  const arrKey = Object.keys(p).find((k) => /ids$/i.test(k) && p[k].type === 'array');
  if (arrKey) return { make: (chunk) => ({ [arrKey]: chunk }), max: Math.min(p[arrKey].maxItems || 10, 10) };
  const k = Object.keys(p).find((x) => /meeting_?id$|note_?id$|^id$/i.test(x)) || 'meeting_id';
  return { make: (chunk) => ({ [k]: chunk[0] }), max: 1 };
}

function nextOffset(res) {
  const j = res.json;
  const v = j && typeof j === 'object' ? (j.next_offset ?? j.nextOffset ?? j.pagination?.next_offset) : undefined;
  if (v !== undefined && v !== null) return Number(v);
  const m = String(res.text || '').match(/next_offset\s*[=:]\s*"?(\d+)/i);
  return m ? Number(m[1]) : null;
}

export class GranolaApi {
  constructor(g, tools) {
    this.g = g;
    this.tools = Object.fromEntries(tools.map((t) => [t.name, t]));
  }

  static async open(g) {
    const t = await g.listTools();
    return new GranolaApi(g, t.tools);
  }

  async accountInfo() { return this.g.call('get_account_info', {}); }

  async folders() {
    if (!this.tools.list_meeting_folders) return [];
    const out = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const args = has(props(this.tools.list_meeting_folders), 'limit') ? { limit: 100 } : {};
      if (offset) args.offset = offset;
      const res = await this.g.call('list_meeting_folders', args);
      this.lastRaw = res;
      out.push(...parseFolders(res));
      const next = nextOffset(res);
      if (!next || next <= offset) break;
      offset = next;
    }
    return out;
  }

  async listMeetings({ from, to, folderId }) {
    const schema = this.tools.list_meetings;
    const all = new Map();
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await this.g.call('list_meetings', buildListArgs(schema, { from, to, folderId, cursor }));
      this.lastRaw = res;
      for (const m of parseMeetings(res)) if (!all.has(m.id)) all.set(m.id, m);
      const next = nextCursor(res);
      if (!next && /has_more="true"/i.test(res.text || '')) this.warnings = [...(this.warnings || []), 'list_meetings said there are more pages but gave no cursor'];
      if (!next || next === cursor) break;
      cursor = next;
    }
    return [...all.values()];
  }

  /** Full meeting details. Returns Map id -> meeting. */
  async getMeetings(ids) {
    const schema = this.tools.get_meetings;
    const { make, max } = idArgs(schema);
    const out = new Map();
    for (let i = 0; i < ids.length; i += max) {
      const args = make(ids.slice(i, i + max));
      if (props(schema).attachments?.enum?.includes('none')) args.attachments = 'none';
      const res = await this.g.call('get_meetings', args);
      this.lastRaw = res;
      for (const m of parseMeetings(res)) out.set(m.id, m);
    }
    return out;
  }

  /** Whole transcript as text, following next_offset pages. */
  async transcript(id) {
    const schema = this.tools.get_meeting_transcript;
    if (!schema) return '';
    const p = props(schema);
    const idKey = has(p, 'meeting_id') ? 'meeting_id' : (Object.keys(p).find((k) => /id$/i.test(k) && p[k].type === 'string') || 'meeting_id');
    const parts = [];
    let offset = 0;
    for (let page = 0; page < 25; page += 1) {
      const args = { [idKey]: id };
      if (has(p, 'max_chars')) args.max_chars = 80000;
      if (offset && has(p, 'offset')) args.offset = offset;
      const res = await this.g.call('get_meeting_transcript', args);
      this.lastRaw = res;
      parts.push(parseTranscript(res));
      const next = nextOffset(res);
      if (!next || next <= offset || !has(p, 'offset')) break;
      offset = next;
    }
    return parts.filter(Boolean).join('\n');
  }
}

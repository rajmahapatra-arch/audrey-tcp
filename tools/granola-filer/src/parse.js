// Parsing Granola MCP tool results into plain objects.
//
// Granola does not document its response format, so this parser accepts both JSON
// (structuredContent or JSON text) and the XML-ish tagged text some MCP servers return,
// using several common key names. Run `node src/cli.js discover` after connecting to
// print the (content-free) shape of each response if anything parses wrongly.

/** Depth-first search for the first scalar whose key matches `re`. */
export function findKey(obj, re, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) return v;
  }
  for (const v of Object.values(obj)) {
    const r = findKey(v, re, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function parseAccountInfo(res) {
  const j = res.json;
  let email; let workspace; let workspaceId;
  if (j) {
    email = findKey(j, /^(email|user_?email)$/i);
    const ws = j.workspace || j.current_workspace || j.currentWorkspace || j.active_workspace || j.activeWorkspace;
    if (ws && typeof ws === 'object') {
      workspace = ws.name || ws.title || ws.display_name || ws.displayName;
      workspaceId = ws.id;
    } else if (typeof ws === 'string') workspace = ws;
    workspace ??= findKey(j, /workspace.?(name|title)/i);
    workspaceId ??= findKey(j, /workspace.?id/i);
  }
  const t = res.text || '';
  email ??= (t.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [])[0];
  if (!workspace) {
    const attr = t.match(/<(?:current_|active_)?workspace\b[^>]*\bname="([^"]+)"/i);
    const line = t.match(/(?:current|active)?\s*workspace(?:\s*name)?\s*[:=]\s*\**\s*([^\n*<]+)/i);
    workspace = (attr?.[1] || line?.[1])?.trim();
  }
  if (!workspaceId) workspaceId = (t.match(/workspace[_\s-]?id\s*[:=]\s*"?([\w-]+)/i) || [])[1];
  return { email, workspace, workspaceId };
}

/** Structure of a value with every string replaced by its length -- safe to print. */
export function shape(v, depth = 0) {
  if (depth > 5) return '...';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length} items)`] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') return `<str ${v.length}>`;
  return typeof v;
}

/** Shape of tagged text: tag names and attribute names only. */
export function textShape(t) {
  const tags = {};
  for (const m of String(t).matchAll(/<([a-zA-Z_][\w-]*)([^>]*)>/g)) {
    const attrs = [...m[2].matchAll(/([\w-]+)=/g)].map((a) => a[1]);
    tags[m[1]] = [...new Set([...(tags[m[1]] || []), ...attrs])];
  }
  return { length: String(t).length, lines: String(t).split('\n').length, tags };
}

// ---------- helpers ----------

const decodeEntities = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

function attrs(s) {
  const o = {};
  for (const m of String(s).matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) o[m[1].toLowerCase()] = decodeEntities(m[2]);
  return o;
}

function tagText(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return decodeEntities(m[1]).trim();
  }
  return undefined;
}

function firstOf(o, keys) {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
}

export function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'object') return parseDate(v.dateTime || v.date_time || v.date || v.start);
  const d = new Date(String(v).replace(/\s+at\s+/i, ' '));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse attendees from an array or from free text like `Jane Doe <jane@x.com>, Bob from Acme <b@y.com>`. */
export function parseAttendees(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((a) => {
      if (typeof a === 'string') return parseAttendees(a)[0] || { name: a.trim(), email: null };
      const email = firstOf(a, ['email', 'email_address', 'emailAddress', 'mail']) || null;
      const name = firstOf(a, ['name', 'display_name', 'displayName', 'full_name', 'fullName'])
        || [a.first_name, a.last_name].filter(Boolean).join(' ') || null;
      return { name, email: email ? String(email).toLowerCase() : null };
    }).filter((a) => a.name || a.email);
  }
  // Granola's text form: `Jane Doe (note creator) from Acme (jane@acme.com), Bob Roe (bob@x.com), Sam`
  // (angle-bracket emails are accepted too). Split on commas/semicolons/newlines outside brackets.
  const text = decodeEntities(String(v));
  const entries = [];
  let depth = 0; let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '<') depth += 1;
    if (ch === ')' || ch === '>') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;\n]/.test(ch)) { entries.push(cur); cur = ''; } else cur += ch;
  }
  entries.push(cur);
  const out = [];
  const have = new Set();
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const em = e.match(/[(<]\s*([^()<>\s@]+@[^()<>\s]+)\s*[)>]/) || e.match(/([\w.+'-]+@[\w-]+(?:\.[\w-]+)+)/);
    const email = em ? em[1].toLowerCase() : null;
    let name = (em ? e.replace(em[0], ' ') : e)
      .replace(/\(\s*note creator\s*\)/i, ' ')
      .replace(/\s+from\s+.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || name.includes('@')) name = null;
    if (email && have.has(email)) continue;
    if (email) have.add(email);
    if (name || email) out.push({ name, email });
  }
  return out;
}

function asText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(asText).join('\n');
  if (typeof v === 'object') return asText(v.markdown || v.text || v.content || v.plain || v.value || JSON.stringify(v));
  return String(v);
}

/** Normalise one meeting record (JSON object) into our meeting shape. */
export function normaliseMeetingObject(o) {
  const id = firstOf(o, ['id', 'meeting_id', 'meetingId', 'document_id', 'note_id', 'uuid']);
  const start = parseDate(firstOf(o, ['meeting_at', 'meetingAt', 'start', 'start_time', 'startTime', 'started_at', 'date', 'meeting_date', 'scheduled_start', 'created_at', 'createdAt']));
  let end = parseDate(firstOf(o, ['end', 'end_time', 'endTime', 'ended_at', 'scheduled_end']));
  const dur = firstOf(o, ['duration_minutes', 'durationMinutes', 'duration']);
  if (!end && start && typeof dur === 'number') end = new Date(start.getTime() + dur * 60000);
  const folders = firstOf(o, ['folders', 'folder_names', 'lists', 'collections']);
  const folderName = firstOf(o, ['folder', 'folder_name', 'folderName']);
  return {
    id: id !== undefined ? String(id) : undefined,
    title: asText(firstOf(o, ['title', 'name', 'meeting_title', 'subject'])).trim(),
    start,
    end,
    attendees: parseAttendees(firstOf(o, ['attendees', 'participants', 'people', 'known_participants', 'invitees'])),
    granolaFolders: [
      ...(Array.isArray(folders) ? folders.map((f) => (typeof f === 'string' ? f : f.name || f.title)).filter(Boolean) : []),
      ...(typeof folderName === 'string' ? [folderName] : []),
    ],
    summary: asText(firstOf(o, ['summary', 'enhanced_notes', 'enhancedNotes', 'ai_summary', 'ai_notes', 'notes_markdown'])).trim(),
    notes: asText(firstOf(o, ['private_notes', 'privateNotes', 'my_notes', 'myNotes', 'user_notes', 'notes'])).trim(),
    link: firstOf(o, ['url', 'link', 'web_url', 'webUrl', 'granola_url', 'share_url']) || null,
    updatedAt: parseDate(firstOf(o, ['updated_at', 'updatedAt'])),
  };
}

/** Find the array of meeting-like objects in a JSON result. */
function meetingArray(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of ['meetings', 'documents', 'notes', 'results', 'items', 'data']) if (Array.isArray(j[k])) return j[k];
  if (j.meeting && typeof j.meeting === 'object') return [j.meeting];
  if (j.id || j.meeting_id) return [j];
  for (const v of Object.values(j)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  return [];
}

/** Parse meetings from tagged text (`<meeting id=".." title=".." date="..">...</meeting>`). */
function meetingsFromText(t) {
  const out = [];
  const re = /<meeting\b([^>]*)>([\s\S]*?)<\/meeting>|<meeting\b([^>]*)\/>/gi;
  for (const m of String(t).matchAll(re)) {
    const a = attrs(m[1] || m[3] || '');
    const body = m[2] || '';
    const o = {
      ...a,
      attendees: tagText(body, ['known_participants', 'participants', 'attendees']) ?? a.attendees ?? a.participants,
      summary: tagText(body, ['summary', 'enhanced_notes', 'ai_notes']),
      private_notes: tagText(body, ['private_notes', 'my_notes', 'user_notes', 'notes']),
      folders: [...body.matchAll(/<folder\b([^>]*)\/?>/gi)].map((f) => { const fa = attrs(f[1]); return fa.title || fa.name; }).filter(Boolean),
      url: tagText(body, ['url', 'link']) || a.url || a.link,
    };
    out.push(normaliseMeetingObject(o));
  }
  return out;
}

export function parseMeetings(res) {
  if (res.json !== undefined) {
    const arr = meetingArray(res.json);
    if (arr.length) return arr.filter((x) => x && typeof x === 'object').map(normaliseMeetingObject).filter((m) => m.id);
  }
  return meetingsFromText(res.text || '').filter((m) => m.id);
}

/** Parse folders: [{id, name}] */
export function parseFolders(res) {
  const out = [];
  if (res.json !== undefined) {
    let arr = res.json;
    if (!Array.isArray(arr)) arr = arr?.folders || arr?.lists || arr?.items || arr?.results || arr?.data || [];
    for (const f of arr) {
      const id = firstOf(f, ['id', 'folder_id', 'folderId', 'list_id']);
      const name = firstOf(f, ['name', 'title', 'folder_name']);
      const parent = firstOf(f, ['parent_folder_id', 'parentFolderId', 'parent_id']);
      if (id !== undefined && name) out.push({ id: String(id), name: String(name), parentId: parent ? String(parent) : null });
    }
    if (out.length) return out;
  }
  const t = res.text || '';
  for (const m of t.matchAll(/<folder\b([^>]*)\/?>/gi)) {
    const a = attrs(m[1]);
    const id = a.id || a.folder_id;
    const name = a.name || a.title;
    if (id && name) out.push({ id, name });
  }
  if (!out.length) {
    // "- Name (id: abc)" or "Name [abc]" style lines
    for (const m of t.matchAll(/^[\s*-]*(.+?)\s*[([]\s*(?:id\s*[:=]\s*)?([\w-]{6,})\s*[)\]]\s*$/gim)) out.push({ id: m[2], name: m[1].trim() });
  }
  return out;
}

/** Transcript to plain text with Granola's speaker labels. */
export function parseTranscript(res) {
  const j = res.json;
  const arr = Array.isArray(j) ? j : (j && (j.transcript || j.segments || j.utterances || j.entries));
  if (Array.isArray(arr)) {
    return arr.map((u) => {
      if (typeof u === 'string') return u;
      const who = firstOf(u, ['speaker', 'speaker_name', 'source', 'speakerName', 'name']);
      const text = asText(firstOf(u, ['text', 'content', 'transcript']));
      return who ? `${who}: ${text}` : text;
    }).join('\n');
  }
  if (j && typeof j === 'object' && typeof j.transcript === 'string') return j.transcript;
  const t = String(res.text || '');
  const inner = tagText(t, ['transcript']);
  return (inner ?? t).trim();
}

/** Pagination cursor if the response carries one. */
export function nextCursor(res) {
  const j = res.json;
  if (j && typeof j === 'object') {
    const c = j.next_cursor ?? j.nextCursor ?? j.cursor ?? j.next_page_token ?? j.pagination?.next_cursor;
    if (c) return String(c);
  }
  const m = String(res.text || '').match(/next[_\s-]?cursor\s*[:=]\s*(?:"([^"]+)"|([\w=+/-]+))/i);
  return m ? (m[1] || m[2]) : null;
}

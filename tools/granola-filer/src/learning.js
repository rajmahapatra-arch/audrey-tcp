// Learning from where meetings end up.
//
// The domain map is always recomputed from the meeting records (where each file is
// *now*), so moving a file -- in or out of the inbox, or between matters -- simply
// changes the evidence; nothing has to be decremented by hand.

import fs from 'node:fs';
import path from 'node:path';
import { locate } from './folders.js';
import { readMeetingId } from './format.js';

/** domain -> { clients: {client: n}, matters: {client: {matter: n}} } */
export function buildDomainMap(state) {
  const map = {};
  for (const rec of Object.values(state.meetings || {})) {
    if (rec.location !== 'filed' || !rec.client) continue;
    for (const d of rec.domains || []) {
      const e = (map[d] ||= { clients: {}, matters: {} });
      e.clients[rec.client] = (e.clients[rec.client] || 0) + 1;
      if (rec.matter) {
        const cm = (e.matters[rec.client] ||= {});
        cm[rec.matter] = (cm[rec.matter] || 0) + 1;
      }
    }
  }
  return map;
}

/** Index every .txt file name under the given roots: lower-case name -> [full paths]. */
export function buildFileIndex(roots, { maxDepth = 8 } = {}) {
  const index = new Map();
  const seen = new Set();
  const walk = (dir, depth) => {
    const key = dir.toLowerCase();
    if (depth > maxDepth || seen.has(key)) return;
    seen.add(key);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.txt')) {
        const k = e.name.toLowerCase();
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(full);
      }
    }
  };
  for (const r of roots) if (r && fs.existsSync(r)) walk(r, 0);
  return index;
}

/**
 * Check every recorded file. If it is no longer where we wrote it, look for it by name
 * under the client root and the inbox (confirming by the Granola meeting ID inside the file).
 * Updates the records in place. Returns counts.
 */
export function detectMoves(state, config, { index, now = new Date() } = {}) {
  let idx = index;
  const getIndex = () => (idx ||= buildFileIndex([config.clientRoot, config.inbox]));
  const result = { checked: 0, moved: 0, missing: 0, toFiled: 0, toInbox: 0 };
  for (const [id, rec] of Object.entries(state.meetings || {})) {
    if (!rec.path || !rec.fileName) continue;
    result.checked += 1;
    if (fs.existsSync(rec.path)) {
      if (rec.location === 'missing') rec.location = rec.client ? 'filed' : 'inbox';
      continue;
    }
    const candidates = (getIndex().get(rec.fileName.toLowerCase()) || []);
    let found = candidates.filter((p) => readMeetingId(p) === id);
    if (!found.length && candidates.length === 1) found = candidates; // ID line edited away: trust a unique name
    if (found.length !== 1) {
      if (rec.location !== 'missing') {
        rec.location = 'missing';
        rec.missingSince = now.toISOString();
        result.missing += 1;
      }
      continue;
    }
    const newPath = found[0];
    const where = locate(config, newPath);
    const prev = { client: rec.client, matter: rec.matter, location: rec.location, path: rec.path };
    rec.history = [...(rec.history || []), { ...prev, until: now.toISOString() }].slice(-10);
    rec.path = newPath;
    rec.movedAt = now.toISOString();
    delete rec.missingSince;
    if (where.inbox) {
      rec.location = 'inbox'; rec.client = null; rec.matter = null; result.toInbox += 1;
    } else if (where.outside) {
      rec.location = 'outside'; rec.client = null; rec.matter = null;
    } else {
      rec.location = 'filed'; rec.client = where.client; rec.matter = where.matter; result.toFiled += 1;
    }
    rec.decidedBy = 'moved-by-you';
    result.moved += 1;
  }
  return result;
}

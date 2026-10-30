// The client/matter folder model on disk.

import fs from 'node:fs';
import path from 'node:path';

/** Normalise a name for comparison: case, accents, punctuation and whitespace. */
export function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** True if normalised `needle` appears in normalised `hay` on word boundaries. */
export function containsWords(hay, needle) {
  const h = ` ${norm(hay)} `;
  const n = norm(needle);
  return n.length > 0 && h.includes(` ${n} `);
}

/**
 * Read the client root. Returns
 *   [{ name, path, matters: [{ name, path }] }]
 * Folders starting with "_" or "." and the configured ignore names (e.g. "Meetings") are skipped.
 */
/**
 * The client roots: config.clientRoots ([{ path, label }]) or, for older configs, the single
 * config.clientRoot.
 */
export function clientRoots(config) {
  if (Array.isArray(config.clientRoots) && config.clientRoots.length) return config.clientRoots;
  return [{ path: config.clientRoot, label: 'Client' }];
}

/**
 * A client folder name that exists under more than one root is ambiguous, so it is given a
 * qualified name, e.g. "zally (WSGR)". Qualified names never match a meeting title on their own,
 * so a meeting is never filed under the wrong root's client by title alone.
 */
export function scanFolders(config) {
  const ignore = new Set((config.ignoreFolderNames || []).map(norm));
  const ok = (d) => d.isDirectory() && !/^[_.~]/.test(d.name) && !ignore.has(norm(d.name));
  const inboxAbs = path.resolve(config.inbox).toLowerCase();
  const all = [];
  for (const root of clientRoots(config)) {
    let entries = [];
    try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
    for (const d of entries.filter(ok)) {
      const cpath = path.join(root.path, d.name);
      if (path.resolve(cpath).toLowerCase() === inboxAbs) continue;
      let matters = [];
      try {
        matters = fs.readdirSync(cpath, { withFileTypes: true }).filter(ok)
          .map((m) => ({ name: m.name, path: path.join(cpath, m.name) }));
      } catch { /* unreadable client folder */ }
      all.push({ name: d.name, path: cpath, root: root.label, matters });
    }
  }
  const counts = new Map();
  for (const c of all) counts.set(norm(c.name), (counts.get(norm(c.name)) || 0) + 1);
  for (const c of all) if (counts.get(norm(c.name)) > 1) c.name = `${c.name} (${c.root})`;
  return all;
}

/** Destination directory for a (client, matter|null) pair. */
export function meetingsDir(config, folders, client, matter) {
  const c = folders.find((f) => f.name === client);
  if (!c) throw new Error('Unknown client folder');
  const base = matter ? path.join(c.path, matter) : c.path;
  return path.join(base, config.meetingsFolderName || 'Meetings');
}

/**
 * Work out (client, matter) from a path under the client root, or {inbox:true}.
 * Client\Matter\Meetings\f.txt -> {client, matter}; Client\Meetings\f.txt -> {client, matter:null}
 */
export function locate(config, filePath, folders = null) {
  const abs = path.resolve(filePath);
  const inbox = path.resolve(config.inbox);
  if (abs.toLowerCase().startsWith(inbox.toLowerCase() + path.sep)) return { inbox: true };
  for (const root of clientRoots(config)) {
    const rel = path.relative(path.resolve(root.path), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    parts.pop(); // file name
    if (parts.length === 0) return { outside: true };
    // Use the scanned (possibly qualified) client name, so learning keys match the rules.
    const cpath = path.resolve(root.path, parts[0]).toLowerCase();
    const known = (folders || scanFolders(config)).find((f) => path.resolve(f.path).toLowerCase() === cpath);
    const client = known ? known.name : parts[0];
    const meetings = norm(config.meetingsFolderName || 'Meetings');
    const matter = parts.length >= 2 && norm(parts[1]) !== meetings ? parts[1] : null;
    return { client, matter };
  }
  return { outside: true };
}

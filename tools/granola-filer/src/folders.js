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
export function scanFolders(config) {
  const ignore = new Set((config.ignoreFolderNames || []).map(norm));
  const ok = (d) => d.isDirectory() && !/^[_.~]/.test(d.name) && !ignore.has(norm(d.name));
  const root = config.clientRoot;
  const inboxAbs = path.resolve(config.inbox).toLowerCase();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(ok)
    .filter((d) => path.resolve(root, d.name).toLowerCase() !== inboxAbs)
    .map((d) => {
      const cpath = path.join(root, d.name);
      let matters = [];
      try {
        matters = fs.readdirSync(cpath, { withFileTypes: true }).filter(ok)
          .map((m) => ({ name: m.name, path: path.join(cpath, m.name) }));
      } catch { /* unreadable client folder */ }
      return { name: d.name, path: cpath, matters };
    });
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
export function locate(config, filePath) {
  const abs = path.resolve(filePath);
  const inbox = path.resolve(config.inbox);
  if (abs.toLowerCase().startsWith(inbox.toLowerCase() + path.sep)) return { inbox: true };
  const rel = path.relative(path.resolve(config.clientRoot), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { outside: true };
  const parts = rel.split(path.sep);
  parts.pop(); // file name
  if (parts.length === 0) return { outside: true };
  const client = parts[0];
  const meetings = norm(config.meetingsFolderName || 'Meetings');
  const matter = parts.length >= 2 && norm(parts[1]) !== meetings ? parts[1] : null;
  return { client, matter };
}

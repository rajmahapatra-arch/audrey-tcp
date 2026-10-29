// Persistent state in %LOCALAPPDATA%\granola-filer\state.json.
//
// Shape:
// {
//   version: 1,
//   account: { email, workspace, workspaceId, recordedAt },
//   meetings: { [meetingId]: { date, fileName, path, client, matter, rule, writtenAt,
//                              domains: [..], location: 'filed'|'inbox'|'missing', movedAt? } },
//   domains: { [domain]: { clients: { [client]: n }, matters: { [client]: { [matter]: n } } } }
// }
//
// No meeting content (titles, summaries, notes, names) is stored here except the
// file name we wrote, which is needed to find the file again if Raj moves it.

import fs from 'node:fs';

export function emptyState() {
  return { version: 1, account: null, meetings: {}, domains: {} };
}

export function loadState(filePath) {
  if (!fs.existsSync(filePath)) return emptyState();
  const s = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { ...emptyState(), ...s };
}

export function saveState(filePath, state) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

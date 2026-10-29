// File naming and the .txt file layout.

import fs from 'node:fs';
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const BOM = '﻿';

/** Make a meeting title safe for a Windows file name. */
export function sanitiseTitle(title, maxLen = 100) {
  let s = String(title || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = 'Untitled meeting';
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Local-date YYYY-MM-DD. */
export function ymdLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function baseFileName(meeting) {
  const date = meeting.start ? ymdLocal(meeting.start) : 'undated';
  return `${date} – ${sanitiseTitle(meeting.title)}.txt`;
}

/** First free name in `dir`: "name.txt", "name (2).txt", "name (3).txt" ... */
export function uniqueFileName(dir, name, exists = (p) => fs.existsSync(p)) {
  if (!exists(path.join(dir, name))) return name;
  const stem = name.replace(/\.txt$/i, '');
  for (let i = 2; i < 1000; i += 1) {
    const n = `${stem} (${i}).txt`;
    if (!exists(path.join(dir, n))) return n;
  }
  throw new Error('Too many files with the same name');
}

function fmtDateTime(d) {
  if (!d) return 'unknown';
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** The text written to disk (without BOM). Uses CRLF so Notepad on any version is happy. */
export function renderMeeting(meeting, transcript) {
  const rule = '='.repeat(72);
  const attendees = (meeting.attendees || []).map((a) => {
    if (a.name && a.email) return `  - ${a.name} <${a.email}>`;
    return `  - ${a.name || `<${a.email}>`}`;
  });
  const timeLine = meeting.end
    ? `${fmtDateTime(meeting.start)} – ${meeting.end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : fmtDateTime(meeting.start);
  const lines = [
    meeting.title || 'Untitled meeting',
    rule,
    `Date/time:          ${timeLine}`,
    `Granola meeting ID: ${meeting.id}`,
    'Attendees:',
    ...(attendees.length ? attendees : ['  (none recorded)']),
  ];
  if (meeting.link) lines.push(`Granola link:       ${meeting.link}`);
  lines.push(
    '',
    rule, 'SUMMARY', rule, meeting.summary || '(no summary)',
    '',
    rule, 'MY NOTES', rule, meeting.notes || '(no notes)',
    '',
    rule, 'TRANSCRIPT', rule, transcript || '(no transcript)',
    '',
  );
  return lines.join('\n').replace(/\r?\n/g, '\r\n');
}

/** Read the Granola meeting ID back out of a file we wrote (first 2 KB only). */
export function readMeetingId(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const m = buf.slice(0, n).toString('utf8').match(/Granola meeting ID:\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

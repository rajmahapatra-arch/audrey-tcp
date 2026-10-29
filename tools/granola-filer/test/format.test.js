import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sanitiseTitle, baseFileName, uniqueFileName, renderMeeting, readMeetingId, BOM } from '../src/format.js';
import { tmpRoot } from './helpers.js';

test('sanitiseTitle makes Windows-safe names', () => {
  assert.equal(sanitiseTitle('A/B: "C" <D> | E? *F*'), 'A B C D E F');
  assert.equal(sanitiseTitle('Trailing dots...  '), 'Trailing dots');
  assert.equal(sanitiseTitle(''), 'Untitled meeting');
  assert.equal(sanitiseTitle('   '), 'Untitled meeting');
  assert.equal(sanitiseTitle('CON'), '_CON');
  assert.equal(sanitiseTitle('line\nbreak\ttab'), 'line break tab');
  assert.equal(sanitiseTitle('x'.repeat(300)).length, 100);
});

test('baseFileName uses local date and an en dash', () => {
  const name = baseFileName({ title: 'Kick-off: phase 2', start: new Date(2026, 9, 5, 9, 30) });
  assert.equal(name, '2026-10-05 – Kick-off phase 2.txt');
});

test('uniqueFileName appends (2), (3)', () => {
  const t = tmpRoot();
  try {
    const dir = t.root;
    assert.equal(uniqueFileName(dir, 'a.txt'), 'a.txt');
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    assert.equal(uniqueFileName(dir, 'a.txt'), 'a (2).txt');
    fs.writeFileSync(path.join(dir, 'a (2).txt'), '');
    assert.equal(uniqueFileName(dir, 'a.txt'), 'a (3).txt');
  } finally { t.cleanup(); }
});

test('renderMeeting layout, CRLF, and ID can be read back', () => {
  const t = tmpRoot();
  try {
    const m = {
      id: 'abc-123', title: 'Board prep', start: new Date(2026, 9, 5, 9, 30), end: null,
      attendees: [{ name: 'Pat Doe', email: 'pat@example.com' }, { name: null, email: 'x@example.com' }, { name: 'Sam', email: null }],
      summary: '- point', notes: '', link: 'https://notes.granola.ai/d/abc-123',
    };
    const text = renderMeeting(m, 'Pat: hello\nSam: hi');
    assert.ok(text.startsWith('Board prep\r\n'));
    assert.match(text, /Granola meeting ID: abc-123/);
    assert.match(text, /  - Pat Doe <pat@example.com>/);
    assert.match(text, /Granola link: +https:\/\/notes/);
    const order = ['SUMMARY', 'MY NOTES', 'TRANSCRIPT'].map((s) => text.indexOf(`\r\n${s}\r\n`));
    assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])));
    assert.match(text, /\(no notes\)/);
    assert.ok(!/[^\r]\n/.test(text));
    const f = path.join(t.root, 'm.txt');
    fs.writeFileSync(f, BOM + text, 'utf8');
    assert.equal(fs.readFileSync(f)[0], 0xEF);
    assert.equal(readMeetingId(f), 'abc-123');
  } finally { t.cleanup(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDomainMap, detectMoves, buildFileIndex } from '../src/learning.js';
import { emptyState } from '../src/state.js';
import { decide } from '../src/rules.js';
import { scanFolders } from '../src/folders.js';
import { tmpRoot } from './helpers.js';

function write(p, id) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `﻿Title\r\n====\r\nGranola meeting ID: ${id}\r\n`, 'utf8');
}

test('domain map counts only filed meetings; matter counts exclude client level', () => {
  const s = emptyState();
  s.meetings = {
    1: { location: 'filed', client: 'A', matter: 'M1', domains: ['a.example'] },
    2: { location: 'filed', client: 'A', matter: null, domains: ['a.example'] },
    3: { location: 'inbox', client: null, matter: null, domains: ['a.example', 'b.example'] },
    4: { location: 'missing', client: 'B', matter: null, domains: ['a.example'] },
  };
  const map = buildDomainMap(s);
  assert.deepEqual(map['a.example'], { clients: { A: 2 }, matters: { A: { M1: 1 } } });
  assert.equal(map['b.example'], undefined);
});

test('move detection: inbox -> matter teaches the domain; matter -> matter; missing', () => {
  const t = tmpRoot();
  try {
    const c = t.config;
    const inboxFile = path.join(c.inbox, '2026-10-01 – Call.txt');
    const filedFile = path.join(t.root, 'Northwind Traders', 'NDA', 'Meetings', '2026-10-02 – Review.txt');
    const goneFile = path.join(c.inbox, '2026-10-03 – Gone.txt');
    write(inboxFile, 'm1'); write(filedFile, 'm2'); write(goneFile, 'm3');
    const s = emptyState();
    s.meetings = {
      m1: { fileName: path.basename(inboxFile), path: inboxFile, location: 'inbox', client: null, matter: null, domains: ['nw.example'] },
      m2: { fileName: path.basename(filedFile), path: filedFile, location: 'filed', client: 'Northwind Traders', matter: 'NDA', domains: ['cr.example'] },
      m3: { fileName: path.basename(goneFile), path: goneFile, location: 'inbox', client: null, matter: null, domains: [] },
    };
    // Raj files m1 into a matter, moves m2 to another client, deletes m3.
    const m1New = path.join(t.root, 'Northwind Traders', 'Supply Agreement', 'Meetings', path.basename(inboxFile));
    fs.mkdirSync(path.dirname(m1New), { recursive: true });
    fs.renameSync(inboxFile, m1New);
    const m2New = path.join(t.root, 'Contoso Robotics', 'Meetings', path.basename(filedFile));
    fs.mkdirSync(path.dirname(m2New), { recursive: true });
    fs.renameSync(filedFile, m2New);
    fs.unlinkSync(goneFile);
    // A same-named decoy with a different meeting ID must not be mistaken for m2.
    write(path.join(t.root, 'Fabrikam', path.basename(filedFile)), 'other');

    const r = detectMoves(s, c, { now: new Date('2026-10-10T10:00:00Z') });
    assert.equal(r.moved, 2);
    assert.equal(r.missing, 1);
    assert.deepEqual([s.meetings.m1.location, s.meetings.m1.client, s.meetings.m1.matter], ['filed', 'Northwind Traders', 'Supply Agreement']);
    assert.equal(s.meetings.m1.path, m1New);
    assert.deepEqual([s.meetings.m2.client, s.meetings.m2.matter], ['Contoso Robotics', null]);
    assert.equal(s.meetings.m2.history.length, 1);
    assert.equal(s.meetings.m3.location, 'missing');

    // The learned map now sends nw.example to Northwind / Supply Agreement.
    const map = buildDomainMap(s);
    assert.deepEqual(map['nw.example'], { clients: { 'Northwind Traders': 1 }, matters: { 'Northwind Traders': { 'Supply Agreement': 1 } } });
    assert.deepEqual(map['cr.example'].clients, { 'Contoso Robotics': 1 });

    // ...and rule b uses it for the next meeting.
    return decide({ title: 'Weekly', granolaFolders: [], attendees: [{ email: 'z@nw.example' }] },
      { folders: scanFolders(c), config: c, domainMap: map }).then((d) => {
      assert.equal(d.rule, 'b');
      assert.equal(d.matter, 'Supply Agreement');
    });
  } finally { t.cleanup(); }
});

test('moving a file back into the inbox removes its learning', () => {
  const t = tmpRoot();
  try {
    const c = t.config;
    const p = path.join(t.root, 'Fabrikam', 'Meetings', 'x.txt');
    write(p, 'm9');
    const s = emptyState();
    s.meetings.m9 = { fileName: 'x.txt', path: p, location: 'filed', client: 'Fabrikam', matter: null, domains: ['fab.example'] };
    const back = path.join(c.inbox, 'x.txt');
    fs.mkdirSync(c.inbox, { recursive: true });
    fs.renameSync(p, back);
    const r = detectMoves(s, c);
    assert.equal(r.toInbox, 1);
    assert.equal(s.meetings.m9.location, 'inbox');
    assert.equal(buildDomainMap(s)['fab.example'], undefined);
  } finally { t.cleanup(); }
});

test('file index ignores non-txt files', () => {
  const t = tmpRoot();
  try {
    write(path.join(t.root, 'Fabrikam', 'a.txt'), 'x');
    fs.writeFileSync(path.join(t.root, 'Fabrikam', 'b.docx'), '');
    const idx = buildFileIndex([t.root]);
    assert.ok(idx.has('a.txt'));
    assert.ok(!idx.has('b.docx'));
  } finally { t.cleanup(); }
});

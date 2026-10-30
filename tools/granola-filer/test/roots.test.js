import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanFolders, locate, meetingsDir } from '../src/folders.js';
import { ruleTitle, ruleGranolaFolder } from '../src/rules.js';
import { tmpRoot } from './helpers.js';

// A second root ("Firm") with one client whose name also exists in the first root.
function twoRoots() {
  const t = tmpRoot();
  const firm = path.join(t.dir, 'Firm');
  for (const p of ['Adventure Works/Licensing', 'Fabrikam/Deal']) fs.mkdirSync(path.join(firm, p), { recursive: true });
  const internal = path.join(t.dir, 'Internal');
  fs.mkdirSync(path.join(internal, 'Team meetings'), { recursive: true });
  t.config.clientRoots = [
    { path: t.root, label: 'Own' },
    { path: firm, label: 'Firm' },
    { path: internal, label: 'Internal' },
  ];
  return { ...t, firm, internal };
}

test('several roots are scanned; a client name in two roots is qualified by root', () => {
  const t = twoRoots();
  try {
    const names = scanFolders(t.config).map((f) => f.name).sort();
    assert.deepEqual(names, ['Adventure Works', 'Contoso Robotics', 'Fabrikam (Firm)', 'Fabrikam (Own)', 'Northwind Traders', 'Team meetings']);
  } finally { t.cleanup(); }
});

test('a qualified (duplicate) client is never chosen from the bare name in a title', () => {
  const t = twoRoots();
  try {
    const folders = scanFolders(t.config);
    assert.equal(ruleTitle('Catch-up with Fabrikam', folders, t.config), null);
  } finally { t.cleanup(); }
});

test('folderMap can target a client in another root, including the qualified name', () => {
  const t = twoRoots();
  try {
    const folders = scanFolders(t.config);
    const a = ruleGranolaFolder({ granolaFolders: ['Weekly team'] }, folders, { 'Weekly team': 'Team meetings' });
    assert.equal(a.client, 'Team meetings');
    const b = ruleGranolaFolder({ granolaFolders: ['Fab deal'] }, folders, { 'Fab deal': 'Fabrikam (Firm)\\Deal' });
    assert.deepEqual([b.client, b.matter], ['Fabrikam (Firm)', 'Deal']);
    assert.equal(meetingsDir(t.config, folders, b.client, b.matter), path.join(t.firm, 'Fabrikam', 'Deal', 'Meetings'));
  } finally { t.cleanup(); }
});

test('locate works in every root and returns the qualified client name', () => {
  const t = twoRoots();
  try {
    const p = path.join(t.firm, 'Fabrikam', 'Deal', 'Meetings', 'x.txt');
    assert.deepEqual(locate(t.config, p), { client: 'Fabrikam (Firm)', matter: 'Deal' });
    const q = path.join(t.firm, 'Adventure Works', 'Meetings', 'y.txt');
    assert.deepEqual(locate(t.config, q), { client: 'Adventure Works', matter: null });
    assert.deepEqual(locate(t.config, path.join(t.dir, 'elsewhere', 'z.txt')), { outside: true });
  } finally { t.cleanup(); }
});

test('matterAliases file a codename to its matter', () => {
  const t = twoRoots();
  try {
    const folders = scanFolders(t.config);
    const config = { ...t.config, matterAliases: { 'Northwind Traders\\Supply Agreement': ['Project Kestrel'] } };
    const r = ruleTitle('Project Kestrel redlines with the other side', folders, config);
    assert.deepEqual([r.client, r.matter], ['Northwind Traders', 'Supply Agreement']);
  } finally { t.cleanup(); }
});

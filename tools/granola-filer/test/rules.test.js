import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFolders, norm, locate } from '../src/folders.js';
import { decide, ruleGranolaFolder, ruleDomains, ruleTitle, signalDomains } from '../src/rules.js';
import { tmpRoot } from './helpers.js';

const ctx = () => {
  const t = tmpRoot();
  const folders = scanFolders(t.config);
  return { ...t, folders };
};

test('scanFolders skips Meetings, _inbox and hidden folders', () => {
  const t = ctx();
  try {
    assert.deepEqual(t.folders.map((f) => f.name).sort(), ['Contoso Robotics', 'Fabrikam', 'Northwind Traders']);
    assert.deepEqual(t.folders.find((f) => f.name === 'Fabrikam').matters, []);
  } finally { t.cleanup(); }
});

test('norm folds case, punctuation, accents and whitespace', () => {
  assert.equal(norm('  Contoso—Robotics,  Ltd. '), 'contoso robotics ltd');
  assert.equal(norm('Café & Co'), 'cafe and co');
});

test('rule a: exact matter, exact client, contained matter, ambiguity', () => {
  const t = ctx();
  try {
    const f = t.folders;
    assert.deepEqual(ruleGranolaFolder({ granolaFolders: ['supply agreement'] }, f), { client: 'Northwind Traders', matter: 'Supply Agreement', reason: 'Granola folder name matches a client/matter folder' });
    assert.equal(ruleGranolaFolder({ granolaFolders: ['FABRIKAM'] }, f).client, 'Fabrikam');
    assert.equal(ruleGranolaFolder({ granolaFolders: ['FABRIKAM'] }, f).matter, null);
    // matter contained in the Granola folder name
    assert.equal(ruleGranolaFolder({ granolaFolders: ['Contoso – Series A calls'] }, f).matter, 'Series A');
    // "Employment" exists under two clients -> ambiguous on its own
    assert.ok(ruleGranolaFolder({ granolaFolders: ['Employment'] }, f).ambiguous);
    // ...but the longest match wins ("Employment related" beats "Employment")
    assert.deepEqual(
      ruleGranolaFolder({ granolaFolders: ['Employment related issues'] }, f).matter,
      'Employment related',
    );
    // client named in the folder disambiguates the matter
    const r = ruleGranolaFolder({ granolaFolders: ['Northwind Traders / Employment'] }, f);
    assert.equal(r.client, 'Northwind Traders');
    assert.equal(r.matter, 'Employment');
    // no match
    assert.equal(ruleGranolaFolder({ granolaFolders: ['Personal'] }, f), null);
    // not a substring hit inside a word
    assert.equal(ruleGranolaFolder({ granolaFolders: ['Brandon catch-up'] }, f), null);
  } finally { t.cleanup(); }
});

test('rule a: config folderMap maps differently-named Granola folders', () => {
  const t = ctx();
  try {
    const r = ruleGranolaFolder({ granolaFolders: ['NWT deals'] }, t.folders, { 'nwt deals': 'Northwind Traders\\NDA' });
    assert.deepEqual([r.client, r.matter], ['Northwind Traders', 'NDA']);
  } finally { t.cleanup(); }
});

test('signalDomains drops own and webmail domains', () => {
  const t = ctx();
  try {
    const d = signalDomains([
      { email: 'raj@xeqtor.com' }, { email: 'x@gmail.com' }, { email: 'a@northwind.example' },
      { email: 'b@NORTHWIND.example' }, { email: null }, { email: 'c@mail.outlook.com' },
    ], t.config);
    assert.deepEqual(d, ['northwind.example']);
  } finally { t.cleanup(); }
});

test('rule b: unique client, unique matter, shared domains', () => {
  const map = {
    'nw.example': { clients: { 'Northwind Traders': 3 }, matters: { 'Northwind Traders': { NDA: 2 } } },
    'shared.example': { clients: { 'Northwind Traders': 1, Fabrikam: 1 }, matters: {} },
    'two.example': { clients: { 'Northwind Traders': 2 }, matters: { 'Northwind Traders': { NDA: 1, Employment: 1 } } },
    'cr.example': { clients: { 'Contoso Robotics': 1 }, matters: {} },
  };
  assert.deepEqual([ruleDomains(['nw.example'], map).client, ruleDomains(['nw.example'], map).matter], ['Northwind Traders', 'NDA']);
  assert.equal(ruleDomains(['two.example'], map).matter, null);
  assert.equal(ruleDomains(['shared.example'], map), null);
  assert.equal(ruleDomains(['nw.example', 'shared.example'], map).client, 'Northwind Traders');
  assert.ok(ruleDomains(['nw.example', 'cr.example'], map).ambiguous);
  assert.equal(ruleDomains(['unknown.example'], map), null);
});

test('rule c: distinctive matter, generic matter needs client, client name', () => {
  const t = ctx();
  try {
    const f = t.folders;
    assert.equal(ruleTitle('Supply agreement redlines', f, t.config).matter, 'Supply Agreement');
    // "NDA" is generic: not enough on its own
    assert.equal(ruleTitle('Quick NDA call', f, t.config), null);
    // ...but fine with the client named
    assert.deepEqual(ruleTitle('Northwind Traders NDA call', f, t.config).matter, 'NDA');
    assert.equal(ruleTitle('Catch-up with Fabrikam', f, t.config).client, 'Fabrikam');
    assert.equal(ruleTitle('Catch-up with Fabrikam', f, t.config).matter, null);
    assert.equal(ruleTitle('Lunch', f, t.config), null);
  } finally { t.cleanup(); }
});

test('decide: order of rules and inbox fallback with reasons', async () => {
  const t = ctx();
  try {
    const base = { folders: t.folders, config: t.config, domainMap: {} };
    let d = await decide({ title: 'Fabrikam sync', granolaFolders: ['Series A'], attendees: [] }, base);
    assert.equal(d.rule, 'a'); assert.equal(d.matter, 'Series A');

    const domainMap = { 'nw.example': { clients: { 'Northwind Traders': 1 }, matters: {} } };
    d = await decide({ title: 'Call', granolaFolders: [], attendees: [{ email: 'p@nw.example' }] }, { ...base, domainMap });
    assert.equal(d.rule, 'b'); assert.equal(d.client, 'Northwind Traders'); assert.equal(d.matter, null);

    // b gives the client; title refines the matter (generic name OK once client known)
    d = await decide({ title: 'NDA review', granolaFolders: [], attendees: [{ email: 'p@nw.example' }] }, { ...base, domainMap });
    assert.equal(d.rule, 'b'); assert.equal(d.matter, 'NDA');

    d = await decide({ title: 'Supply Agreement', granolaFolders: [], attendees: [] }, base);
    assert.equal(d.rule, 'c');

    d = await decide({ title: 'Dentist', granolaFolders: [], attendees: [{ email: 'q@new.example' }] }, base);
    assert.equal(d.rule, 'e'); assert.equal(d.client, null);
    assert.match(d.reason, /not yet learned/);
  } finally { t.cleanup(); }
});

test('decide: model hook is used only when provided, with threshold', async () => {
  const t = ctx();
  try {
    const base = { folders: t.folders, config: t.config, domainMap: {} };
    const m = { title: 'Dentist', granolaFolders: [], attendees: [] };
    const hi = { name: 'fake', classify: async () => ({ client: 'Fabrikam', matter: null, confidence: 0.92 }) };
    const lo = { name: 'fake', classify: async () => ({ client: 'Fabrikam', matter: null, confidence: 0.5 }) };
    assert.equal((await decide(m, { ...base, classifier: hi })).rule, 'd');
    const r = await decide(m, { ...base, classifier: lo });
    assert.equal(r.rule, 'e');
    assert.match(r.suggestion, /Fabrikam/);
  } finally { t.cleanup(); }
});

test('locate maps paths back to client/matter/inbox', () => {
  const t = ctx();
  try {
    const c = t.config;
    assert.deepEqual(locate(c, `${t.root}\\Northwind Traders\\NDA\\Meetings\\x.txt`), { client: 'Northwind Traders', matter: 'NDA' });
    assert.deepEqual(locate(c, `${t.root}\\Fabrikam\\Meetings\\x.txt`), { client: 'Fabrikam', matter: null });
    assert.deepEqual(locate(c, `${t.root}\\_Meetings to file\\x.txt`), { inbox: true });
    assert.ok(locate(c, 'C:\\elsewhere\\x.txt').outside);
  } finally { t.cleanup(); }
});

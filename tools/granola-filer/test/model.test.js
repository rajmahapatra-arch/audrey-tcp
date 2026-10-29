import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OllamaClassifier, createClassifier, validateAnswer, NEW_MATTER, CLIENT_LEVEL } from '../src/model.js';
import { scanFolders } from '../src/folders.js';
import { tmpRoot } from './helpers.js';

function fakeOllama(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      const r = typeof reply === 'function' ? reply() : reply;
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: JSON.stringify(r.content) }, done: true }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('provider "none" disables the model', () => {
  assert.equal(createClassifier({ model: { provider: 'none' } }), null);
});

test('ollama provider sends a schema-constrained request and validates the answer', async () => {
  const t = tmpRoot();
  const folders = scanFolders(t.config);
  const fake = await fakeOllama({ content: { client: 'Northwind Traders', matter: 'NDA', confidence: 0.91 } });
  try {
    const clf = new OllamaClassifier({ url: fake.url, model: 'test-model' });
    const r = await clf.classify({ title: 'T', attendeeDomains: ['nw.example'], summaryExcerpt: 'S', folders });
    assert.deepEqual([r.client, r.matter, r.confidence], ['Northwind Traders', 'NDA', 0.91]);
    const req = fake.seen[0];
    assert.equal(req.url, '/api/chat');
    assert.equal(req.body.model, 'test-model');
    assert.equal(req.body.stream, false);
    assert.equal(req.body.format.type, 'object');
    assert.ok(req.body.format.properties.client.enum.includes('Fabrikam'));
    assert.ok(req.body.format.properties.matter.enum.includes(CLIENT_LEVEL));
  } finally { fake.server.close(); t.cleanup(); }
});

test('ollama provider: new matter only inside an existing client; invented clients rejected', async () => {
  const t = tmpRoot();
  const folders = scanFolders(t.config);
  try {
    const nm = validateAnswer({ client: 'Fabrikam', matter: NEW_MATTER, new_matter_name: 'Lease: renewal', confidence: 0.9 }, folders);
    assert.equal(nm.newMatterName, 'Lease renewal');
    assert.equal(nm.client, 'Fabrikam');
    assert.equal(validateAnswer({ client: 'Brand New Client', matter: CLIENT_LEVEL, confidence: 0.99 }, folders), null);
    // matter that belongs to another client => capped confidence, client level
    const wrong = validateAnswer({ client: 'Fabrikam', matter: 'NDA', confidence: 0.95 }, folders);
    assert.equal(wrong.matter, null);
    assert.ok(wrong.confidence <= 0.5);
  } finally { t.cleanup(); }
});

test('ollama provider surfaces HTTP errors and refuses non-local URLs', async () => {
  const fake = await fakeOllama({ status: 500, content: {} });
  try {
    const clf = new OllamaClassifier({ url: fake.url, model: 'm' });
    await assert.rejects(clf.classify({ title: '', attendeeDomains: [], summaryExcerpt: '', folders: [] }), /HTTP 500/);
  } finally { fake.server.close(); }
  assert.throws(() => new OllamaClassifier({ url: 'http://example.com:11434', model: 'm' }), /this computer/);
});

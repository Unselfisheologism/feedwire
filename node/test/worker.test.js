const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

// The worker imports JSON/HTML via wrangler bundler rules, which plain Node can't do.
// Swap those two imports for inline values, then load the rest of the file unchanged.
async function loadWorker() {
  const dir = path.join(__dirname, '..', 'examples', 'worker');
  let src = fs.readFileSync(path.join(dir, 'worker.mjs'), 'utf8');
  const root = path.join(__dirname, '..');
  src = src
    .replace("import core from '../../core.js';", `import core from ${JSON.stringify(pathToFileURL(path.join(root, 'core.js')).href)};`)
    .replace("import SCHEMA from '../../feedback.schema.json';", `const SCHEMA = ${fs.readFileSync(path.join(root, 'feedback.schema.json'), 'utf8')};`)
    .replace("import DASHBOARD from '../../dashboard.html';", `const DASHBOARD = ${JSON.stringify(fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8'))};`);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-')), 'worker.mjs');
  fs.writeFileSync(f, src);
  return (await import(pathToFileURL(f).href)).default;
}

// Minimal D1 look-alike over node:sqlite.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'examples', 'worker', 'schema.sql'), 'utf8'));
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      const mk = (args) => ({
        bind: (...a) => mk(a),
        run: async () => { st.run(...args); return { success: true }; },
        first: async () => st.get(...args) || null,
        all: async () => ({ results: st.all(...args) }),
      });
      return mk([]);
    },
  };
}

const good = { type: 'bug', summary: 'POST /users 500', severity: 'high', context: { method: 'POST', path: '/users', status_code: 500 }, agent: { name: 'bot' } };
const call = (w, env, p, init = {}) => w.fetch(new Request('http://x' + p, init), env);
const post = (w, env, body) => call(w, env, '/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' }, body: JSON.stringify(body) });
const admin = { authorization: 'Bearer tok' };

test('worker: discovery, schema, dashboard', async () => {
  const w = await loadWorker(); const env = { DB: fakeD1(), FEEDBACK_ADMIN_TOKEN: 'tok' };
  assert.equal((await (await call(w, env, '/.well-known/feedback.json')).json()).feedback_endpoint, '/feedback');
  assert.equal((await (await call(w, env, '/feedback/schema')).json()).additionalProperties, false);
  const d = await call(w, env, '/feedback/admin');
  assert.equal(d.status, 200);
  assert.match(await d.text(), /Feedwire/);
});

test('worker: submit, validate, review, stats', async () => {
  const w = await loadWorker(); const env = { DB: fakeD1(), FEEDBACK_ADMIN_TOKEN: 'tok' };
  const r = await post(w, env, good);
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.equal((await post(w, env, { type: 'nope' })).status, 400);
  assert.equal((await call(w, env, '/feedback', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await call(w, env, '/feedback/admin/api/items')).status, 401);
  assert.equal((await call(w, env, '/feedback/admin/api/items', { headers: { authorization: 'Bearer bad' } })).status, 401);
  const list = await (await call(w, env, '/feedback/admin/api/items', { headers: admin })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].untrusted, true);
  const pr = await call(w, env, '/feedback/admin/api/items/' + id, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'triaged', note: 'ok' }) });
  assert.equal(pr.status, 200);
  assert.equal((await pr.json()).status, 'triaged');
  assert.equal((await call(w, env, '/feedback/admin/api/items?status=bogus', { headers: admin })).status, 400);
  const s = await (await call(w, env, '/feedback/admin/api/stats', { headers: admin })).json();
  assert.equal(s.total, 1);
  assert.equal(s.top_struggles[0].key, 'POST /users | bug');
});

test('worker: admin disabled without secret, oversize body, rate limit', async () => {
  const w = await loadWorker(); const env = { DB: fakeD1() };
  assert.equal((await call(w, env, '/feedback/admin/api/items', { headers: admin })).status, 401);
  const big = await call(w, env, '/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '2.2.2.2' }, body: JSON.stringify({ type: 'bug', summary: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  let last;
  for (let i = 0; i < 32; i++) last = await post(w, env, good);
  assert.equal(last.status, 429);
});

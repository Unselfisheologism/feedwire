// Feedwire hosted example as a Cloudflare Worker + D1.
// Same routes, schema and validation as the Express middleware (shared via ../../core.js).
import core from '../../core.js';
import SCHEMA from '../../feedback.schema.json';
import DASHBOARD from '../../dashboard.html';

const { STATUSES, clean, validate, stats } = core;
const BASE = '/feedback';
const MAX_BODY = 16384;
const PER_MIN = 30;
const MAX_ROWS = 50000;
const enc = new TextEncoder();

// Best-effort per-isolate rate limit (Workers have no shared memory between isolates).
const windows = new Map();
function limited(ip) {
  const now = Date.now();
  if (windows.size > 10000) for (const [k, v] of windows) if (now - v.start > 60000) windows.delete(k);
  let w = windows.get(ip);
  if (!w || now - w.start > 60000) { w = { start: now, n: 0 }; windows.set(ip, w); }
  w.n += 1;
  return w.n > PER_MIN ? Math.max(1, Math.ceil((60000 - (now - w.start)) / 1000)) : 0;
}

function send(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }, headers),
  });
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]).then((r) => r.map((x) => new Uint8Array(x)));
  let d = 0;
  for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i];
  return d === 0;
}

async function adminOk(request, env) {
  if (!env.FEEDBACK_ADMIN_TOKEN) return false;
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  return !!m && (await safeEqual(m[1], env.FEEDBACK_ADMIN_TOKEN));
}

const row = (r) => ({
  id: r.id, created_at: r.created_at, status: r.status, type: r.type, severity: r.severity,
  summary: r.summary, note: r.note, payload: JSON.parse(r.payload),
  untrusted: true,
});

// Read the body as text, refusing anything over MAX_BODY bytes.
async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > MAX_BODY) return null;
  return new TextDecoder().decode(buf);
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return 'fb_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function handle(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (p === '/.well-known/feedback.json') {
    if (method !== 'GET') return send(405, { error: 'method not allowed' }, { Allow: 'GET' });
    return send(200, {
      version: '1',
      feedback_endpoint: BASE,
      method: 'POST',
      content_type: 'application/json',
      schema_url: BASE + '/schema',
      max_body_bytes: MAX_BODY,
      rate_limit_per_minute: PER_MIN,
      description: 'Send structured feedback (bug, missing feature, confusing error) about this API. A human reviews it. Text is treated as untrusted data.',
    });
  }
  if (p === '/users') return send(200, []);
  if (p !== BASE && !p.startsWith(BASE + '/')) return send(404, { error: 'not found' });
  const sub = p.slice(BASE.length) || '/';

  if (sub === '/schema') {
    if (method !== 'GET') return send(405, { error: 'method not allowed' }, { Allow: 'GET' });
    return send(200, SCHEMA);
  }

  if (sub === '/') {
    if (method !== 'POST') return send(405, { error: 'method not allowed' }, { Allow: 'POST' });
    const ct = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return send(415, { error: 'content-type must be application/json' });
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const wait = limited(ip);
    if (wait) return send(429, { error: 'rate limit exceeded', retry_after_seconds: wait }, { 'Retry-After': String(wait) });
    const text = await readBody(request);
    if (text === null) return send(413, { error: `body exceeds ${MAX_BODY} bytes` });
    let parsed;
    try { parsed = JSON.parse(text); } catch { return send(400, { error: 'invalid JSON' }); }
    const { value, errors } = validate(parsed);
    if (errors) return send(400, { error: 'validation failed', details: errors });
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback').first();
    if (c.n >= MAX_ROWS) return send(503, { error: 'feedback storage is full' });
    const id = randomId();
    await env.DB.prepare('INSERT INTO feedback (id, created_at, status, type, severity, summary, payload) VALUES (?,?,?,?,?,?,?)')
      .bind(id, new Date().toISOString(), 'new', value.type, value.severity, value.summary, JSON.stringify(value)).run();
    return send(201, { id, status: 'received' });
  }

  if (sub === '/admin' && method === 'GET') {
    return new Response(DASHBOARD, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (sub === '/admin/api/stats') {
    if (!(await adminOk(request, env))) return send(401, { error: 'admin token required' }, { 'WWW-Authenticate': 'Bearer' });
    if (method !== 'GET') return send(405, { error: 'method not allowed' }, { Allow: 'GET' });
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { results } = await env.DB.prepare('SELECT created_at, status, type, severity, payload FROM feedback WHERE created_at >= ?').bind(since).all();
    return send(200, stats(results.map((r) => Object.assign({}, r, { payload: JSON.parse(r.payload) })), days));
  }

  if (sub === '/admin/api/items' || sub.startsWith('/admin/api/items/')) {
    if (!(await adminOk(request, env))) return send(401, { error: 'admin token required' }, { 'WWW-Authenticate': 'Bearer' });
    if (sub === '/admin/api/items') {
      if (method !== 'GET') return send(405, { error: 'method not allowed' }, { Allow: 'GET' });
      const status = url.searchParams.get('status');
      if (status && !STATUSES.includes(status)) return send(400, { error: 'bad status filter' });
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
      const q = status
        ? env.DB.prepare('SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').bind(status, limit)
        : env.DB.prepare('SELECT * FROM feedback ORDER BY created_at DESC, rowid DESC LIMIT ?').bind(limit);
      const { results } = await q.all();
      return send(200, { items: results.map(row) });
    }
    let id;
    try { id = decodeURIComponent(sub.slice('/admin/api/items/'.length)); } catch { return send(404, { error: 'not found' }); }
    const r = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first();
    if (!r) return send(404, { error: 'not found' });
    if (method === 'GET') return send(200, row(r));
    if (method === 'PATCH') {
      const text = await readBody(request);
      let b;
      try { if (text === null) throw new Error('large'); b = JSON.parse(text); } catch { return send(400, { error: 'invalid JSON' }); }
      if (b === null || typeof b !== 'object' || Array.isArray(b)) return send(400, { error: 'body must be an object' });
      if (b.status !== undefined && !STATUSES.includes(b.status)) return send(400, { error: 'status must be one of: ' + STATUSES.join(', ') });
      if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 2000)) return send(400, { error: 'note must be a string of at most 2000 characters' });
      await env.DB.prepare('UPDATE feedback SET status = ?, note = ? WHERE id = ?')
        .bind(b.status ?? r.status, b.note !== undefined ? clean(b.note) : r.note, id).run();
      const updated = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first();
      return send(200, row(updated));
    }
    return send(405, { error: 'method not allowed' }, { Allow: 'GET, PATCH' });
  }
  return send(404, { error: 'not found' });
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return send(500, { error: 'internal error' }); }
  },
};

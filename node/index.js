'use strict';
// SuperFeedback middleware for Express (or any connect-style server).
// Storage: node:sqlite (built into Node >= 22.5). No runtime dependencies.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = ['bug', 'missing_feature', 'confusing_error', 'docs', 'performance', 'other'];
const SEVERITIES = ['low', 'medium', 'high'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const STATUSES = ['new', 'triaged', 'accepted', 'rejected', 'done'];
const STR_FIELDS = { summary: 200, details: 4000, expected: 1000, actual: 1000, suggestion: 2000 };
const TOP_KEYS = ['type', 'summary', 'details', 'severity', 'expected', 'actual', 'suggestion', 'context', 'agent'];
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'feedback.schema.json'), 'utf8'));
const DASHBOARD = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

// Remove control chars (keep \n and \t) and NULs so stored text is plain text.
function clean(s) {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function validate(body) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: '', message: 'body must be a JSON object' }] };
  }
  for (const k of Object.keys(body)) if (!TOP_KEYS.includes(k)) err(k, 'unknown field');
  if (!TYPES.includes(body.type)) err('type', 'must be one of: ' + TYPES.join(', '));
  const out = { type: body.type };
  for (const [f, max] of Object.entries(STR_FIELDS)) {
    const v = body[f];
    if (v === undefined) {
      if (f === 'summary') err(f, 'required');
      continue;
    }
    if (typeof v !== 'string') { err(f, 'must be a string'); continue; }
    const c = clean(v).trim();
    if (f === 'summary' && c.length === 0) err(f, 'must not be empty');
    else if (c.length > max) err(f, `must be at most ${max} characters`);
    else out[f] = c;
  }
  if (body.severity === undefined) out.severity = 'low';
  else if (!SEVERITIES.includes(body.severity)) err('severity', 'must be one of: ' + SEVERITIES.join(', '));
  else out.severity = body.severity;
  if (body.context !== undefined) {
    const c = body.context;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) err('context', 'must be an object');
    else {
      const oc = {};
      for (const k of Object.keys(c)) if (!['method', 'path', 'status_code', 'error_message'].includes(k)) err('context.' + k, 'unknown field');
      if (c.method !== undefined) { if (!METHODS.includes(c.method)) err('context.method', 'must be one of: ' + METHODS.join(', ')); else oc.method = c.method; }
      if (c.path !== undefined) { if (typeof c.path !== 'string' || c.path.length > 300) err('context.path', 'must be a string of at most 300 characters'); else oc.path = clean(c.path); }
      if (c.status_code !== undefined) { if (!Number.isInteger(c.status_code) || c.status_code < 100 || c.status_code > 599) err('context.status_code', 'must be an integer from 100 to 599'); else oc.status_code = c.status_code; }
      if (c.error_message !== undefined) { if (typeof c.error_message !== 'string' || c.error_message.length > 1000) err('context.error_message', 'must be a string of at most 1000 characters'); else oc.error_message = clean(c.error_message); }
      out.context = oc;
    }
  }
  if (body.agent !== undefined) {
    const a = body.agent;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) err('agent', 'must be an object');
    else {
      const oa = {};
      for (const k of Object.keys(a)) if (!['name', 'version'].includes(k)) err('agent.' + k, 'unknown field');
      if (a.name !== undefined) { if (typeof a.name !== 'string' || a.name.length > 100) err('agent.name', 'must be a string of at most 100 characters'); else oa.name = clean(a.name); }
      if (a.version !== undefined) { if (typeof a.version !== 'string' || a.version.length > 50) err('agent.version', 'must be a string of at most 50 characters'); else oa.version = clean(a.version); }
      out.agent = oa;
    }
  }
  return errors.length ? { errors } : { value: out };
}

const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n).map(([key, count]) => ({ key, count }));
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

// What are agents struggling with? Aggregates over rows from the last `days` days.
function stats(rows, days) {
  const by = { type: new Map(), severity: new Map(), status: new Map(), endpoint: new Map(), agent: new Map(), day: new Map() };
  const struggles = new Map();
  for (const r of rows) {
    bump(by.type, r.type); bump(by.severity, r.severity); bump(by.status, r.status);
    bump(by.day, r.created_at.slice(0, 10));
    const c = r.payload.context;
    if (c && c.path) {
      const ep = (c.method ? c.method + ' ' : '') + c.path;
      bump(by.endpoint, ep);
      bump(struggles, ep + ' | ' + r.type);
    }
    if (r.payload.agent && r.payload.agent.name) bump(by.agent, r.payload.agent.name);
  }
  return {
    window_days: days, total: rows.length,
    by_type: top(by.type), by_severity: top(by.severity), by_status: top(by.status),
    top_endpoints: top(by.endpoint), top_struggles: top(struggles), top_agents: top(by.agent),
    per_day: [...by.day.entries()].sort().map(([key, count]) => ({ key, count })),
    unreviewed: by.status.get('new') || 0,
  };
}

function send(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {object} opts
 * @param {string} [opts.dbPath=':memory:']  SQLite file path
 * @param {string} [opts.adminToken]         Bearer token for the review API. Unset = review API disabled.
 * @param {string} [opts.basePath='/feedback']
 * @param {number} [opts.maxBodyBytes=16384]
 * @param {number} [opts.rateLimitPerMinute=30]  per client IP
 * @param {number} [opts.maxRows=50000]      new submissions are refused (503) past this
 * @param {boolean} [opts.trustProxy=false]  use X-Forwarded-For for rate limiting
 */
function feedback(opts = {}) {
  const base = (opts.basePath || '/feedback').replace(/\/+$/, '');
  const maxBody = opts.maxBodyBytes || 16384;
  const perMin = opts.rateLimitPerMinute || 30;
  const maxRows = opts.maxRows || 50000;
  const db = new DatabaseSync(opts.dbPath || ':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )`);
  const insert = db.prepare('INSERT INTO feedback (id, created_at, status, type, severity, summary, payload) VALUES (?,?,?,?,?,?,?)');
  const count = db.prepare('SELECT COUNT(*) AS n FROM feedback');
  const windows = new Map();

  function limited(ip) {
    const now = Date.now();
    if (windows.size > 10000) for (const [k, v] of windows) if (now - v.start > 60000) windows.delete(k);
    let w = windows.get(ip);
    if (!w || now - w.start > 60000) { w = { start: now, n: 0 }; windows.set(ip, w); }
    w.n += 1;
    return w.n > perMin ? Math.max(1, Math.ceil((60000 - (now - w.start)) / 1000)) : 0;
  }
  const clientIp = (req) => {
    if (opts.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const row = (r) => ({
    id: r.id, created_at: r.created_at, status: r.status, type: r.type, severity: r.severity,
    summary: r.summary, note: r.note, payload: JSON.parse(r.payload),
    untrusted: true,
  });
  const adminOk = (req) => {
    if (!opts.adminToken) return false;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && safeEqual(m[1], opts.adminToken);
  };

  return async function superfeedback(req, res, next) {
    try {
      const url = new URL(req.originalUrl || req.url, 'http://x');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method;

      if (p === '/.well-known/feedback.json') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        return send(res, 200, {
          version: '1',
          feedback_endpoint: base,
          method: 'POST',
          content_type: 'application/json',
          schema_url: base + '/schema',
          max_body_bytes: maxBody,
          rate_limit_per_minute: perMin,
          description: 'Send structured feedback (bug, missing feature, confusing error) about this API. A human reviews it. Text is treated as untrusted data.',
        });
      }
      if (p !== base && !p.startsWith(base + '/')) return next();
      const sub = p.slice(base.length) || '/';

      if (sub === '/schema') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        return send(res, 200, SCHEMA);
      }

      if (sub === '/') {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') return send(res, 415, { error: 'content-type must be application/json' });
        const wait = limited(clientIp(req));
        if (wait) return send(res, 429, { error: 'rate limit exceeded', retry_after_seconds: wait }, { 'Retry-After': String(wait) });
        let text;
        try { text = await readBody(req, maxBody); }
        catch (e) {
          if (e.code === 'TOO_LARGE') return send(res, 413, { error: `body exceeds ${maxBody} bytes` }, { Connection: 'close' });
          throw e;
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const { value, errors } = validate(parsed);
        if (errors) return send(res, 400, { error: 'validation failed', details: errors });
        if (count.get().n >= maxRows) return send(res, 503, { error: 'feedback storage is full' });
        const id = 'fb_' + crypto.randomBytes(8).toString('hex');
        insert.run(id, new Date().toISOString(), 'new', value.type, value.severity, value.summary, JSON.stringify(value));
        return send(res, 201, { id, status: 'received' });
      }

      if (sub === '/admin' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        return res.end(DASHBOARD);
      }

      if (sub === '/admin/api/stats') {
        if (!adminOk(req)) return send(res, 401, { error: 'admin token required' }, { 'WWW-Authenticate': 'Bearer' });
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const rows = db.prepare('SELECT created_at, status, type, severity, payload FROM feedback WHERE created_at >= ?').all(since);
        return send(res, 200, stats(rows.map((r) => Object.assign({}, r, { payload: JSON.parse(r.payload) })), days));
      }

      if (sub === '/admin/api/items' || sub.startsWith('/admin/api/items/')) {
        if (!adminOk(req)) return send(res, 401, { error: 'admin token required' }, { 'WWW-Authenticate': 'Bearer' });
        if (sub === '/admin/api/items') {
          if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
          const status = url.searchParams.get('status');
          if (status && !STATUSES.includes(status)) return send(res, 400, { error: 'bad status filter' });
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
          const rows = status
            ? db.prepare('SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(status, limit)
            : db.prepare('SELECT * FROM feedback ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
          return send(res, 200, { items: rows.map(row) });
        }
        const id = decodeURIComponent(sub.slice('/admin/api/items/'.length));
        const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
        if (!r) return send(res, 404, { error: 'not found' });
        if (method === 'GET') return send(res, 200, row(r));
        if (method === 'PATCH') {
          let b;
          try { b = JSON.parse(await readBody(req, maxBody)); } catch { return send(res, 400, { error: 'invalid JSON' }); }
          if (b === null || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'body must be an object' });
          if (b.status !== undefined && !STATUSES.includes(b.status)) return send(res, 400, { error: 'status must be one of: ' + STATUSES.join(', ') });
          if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 2000)) return send(res, 400, { error: 'note must be a string of at most 2000 characters' });
          db.prepare('UPDATE feedback SET status = ?, note = ? WHERE id = ?').run(b.status ?? r.status, b.note !== undefined ? clean(b.note) : r.note, id);
          return send(res, 200, row(db.prepare('SELECT * FROM feedback WHERE id = ?').get(id)));
        }
        return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PATCH' });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (typeof next === 'function' && !res.headersSent) return next(e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  };
}

module.exports = { feedback, validate, STATUSES };

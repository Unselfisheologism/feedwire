'use strict';
// Pure logic shared by the Express middleware and the Cloudflare Worker. No runtime dependencies.
const TYPES = ['bug', 'missing_feature', 'confusing_error', 'docs', 'performance', 'other'];
const SEVERITIES = ['low', 'medium', 'high'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const STATUSES = ['new', 'triaged', 'accepted', 'rejected', 'done'];
const STR_FIELDS = { summary: 200, details: 4000, expected: 1000, actual: 1000, suggestion: 2000 };
const TOP_KEYS = ['type', 'summary', 'details', 'severity', 'expected', 'actual', 'suggestion', 'context', 'agent'];

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

module.exports = { TYPES, SEVERITIES, METHODS, STATUSES, STR_FIELDS, TOP_KEYS, clean, validate, stats };

"""SuperFeedback for FastAPI. Storage: stdlib sqlite3. Dependencies: fastapi only."""
import json
import hmac
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

TYPES = ["bug", "missing_feature", "confusing_error", "docs", "performance", "other"]
SEVERITIES = ["low", "medium", "high"]
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
STATUSES = ["new", "triaged", "accepted", "rejected", "done"]
STR_FIELDS = {"summary": 200, "details": 4000, "expected": 1000, "actual": 1000, "suggestion": 2000}
TOP_KEYS = ["type", "summary", "details", "severity", "expected", "actual", "suggestion", "context", "agent"]

_HERE = Path(__file__).parent
SCHEMA = json.loads((_HERE / "feedback.schema.json").read_text())
DASHBOARD = (_HERE / "dashboard.html").read_text()
_CTRL = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")


def _clean(s):
    return _CTRL.sub("", s)


def validate(body):
    """Return (value, errors). Exactly one is None."""
    errors = []

    def err(field, message):
        errors.append({"field": field, "message": message})

    if not isinstance(body, dict):
        return None, [{"field": "", "message": "body must be a JSON object"}]
    for k in body:
        if k not in TOP_KEYS:
            err(k, "unknown field")
    if body.get("type") not in TYPES:
        err("type", "must be one of: " + ", ".join(TYPES))
    out = {"type": body.get("type")}
    for f, mx in STR_FIELDS.items():
        if f not in body:
            if f == "summary":
                err(f, "required")
            continue
        v = body[f]
        if not isinstance(v, str):
            err(f, "must be a string")
            continue
        c = _clean(v).strip()
        if f == "summary" and not c:
            err(f, "must not be empty")
        elif len(c) > mx:
            err(f, f"must be at most {mx} characters")
        else:
            out[f] = c
    if "severity" not in body:
        out["severity"] = "low"
    elif body["severity"] not in SEVERITIES:
        err("severity", "must be one of: " + ", ".join(SEVERITIES))
    else:
        out["severity"] = body["severity"]

    if "context" in body:
        c = body["context"]
        if not isinstance(c, dict):
            err("context", "must be an object")
        else:
            oc = {}
            for k in c:
                if k not in ("method", "path", "status_code", "error_message"):
                    err("context." + k, "unknown field")
            if "method" in c:
                if c["method"] not in METHODS:
                    err("context.method", "must be one of: " + ", ".join(METHODS))
                else:
                    oc["method"] = c["method"]
            if "path" in c:
                if not isinstance(c["path"], str) or len(c["path"]) > 300:
                    err("context.path", "must be a string of at most 300 characters")
                else:
                    oc["path"] = _clean(c["path"])
            if "status_code" in c:
                sc = c["status_code"]
                if isinstance(sc, bool) or not isinstance(sc, int) or not 100 <= sc <= 599:
                    err("context.status_code", "must be an integer from 100 to 599")
                else:
                    oc["status_code"] = sc
            if "error_message" in c:
                if not isinstance(c["error_message"], str) or len(c["error_message"]) > 1000:
                    err("context.error_message", "must be a string of at most 1000 characters")
                else:
                    oc["error_message"] = _clean(c["error_message"])
            out["context"] = oc
    if "agent" in body:
        a = body["agent"]
        if not isinstance(a, dict):
            err("agent", "must be an object")
        else:
            oa = {}
            for k in a:
                if k not in ("name", "version"):
                    err("agent." + k, "unknown field")
            for k, mx in (("name", 100), ("version", 50)):
                if k in a:
                    if not isinstance(a[k], str) or len(a[k]) > mx:
                        err("agent." + k, f"must be a string of at most {mx} characters")
                    else:
                        oa[k] = _clean(a[k])
            out["agent"] = oa
    return (None, errors) if errors else (out, None)


def _top(counter, n=10):
    return [{"key": k, "count": c} for k, c in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))[:n]]


def compute_stats(rows, days):
    """What are agents struggling with? rows: dicts with created_at, status, type, severity, payload."""
    from collections import Counter
    by = {k: Counter() for k in ("type", "severity", "status", "endpoint", "agent", "day", "struggle")}
    for r in rows:
        by["type"][r["type"]] += 1
        by["severity"][r["severity"]] += 1
        by["status"][r["status"]] += 1
        by["day"][r["created_at"][:10]] += 1
        c = r["payload"].get("context")
        if c and c.get("path"):
            ep = (c["method"] + " " if c.get("method") else "") + c["path"]
            by["endpoint"][ep] += 1
            by["struggle"][ep + " | " + r["type"]] += 1
        a = r["payload"].get("agent")
        if a and a.get("name"):
            by["agent"][a["name"]] += 1
    return {
        "window_days": days, "total": len(rows),
        "by_type": _top(by["type"]), "by_severity": _top(by["severity"]), "by_status": _top(by["status"]),
        "top_endpoints": _top(by["endpoint"]), "top_struggles": _top(by["struggle"]), "top_agents": _top(by["agent"]),
        "per_day": [{"key": k, "count": by["day"][k]} for k in sorted(by["day"])],
        "unreviewed": by["status"]["new"],
    }


def _json(status, obj, headers=None):
    h = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    h.update(headers or {})
    return JSONResponse(obj, status_code=status, headers=h)


class _TooLarge(Exception):
    pass


async def _read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _TooLarge()
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _TooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


def create_feedback_router(
    db_path=":memory:",
    admin_token=None,
    base_path="/feedback",
    max_body_bytes=16384,
    rate_limit_per_minute=30,
    max_rows=50000,
    trust_proxy=False,
):
    """Return an APIRouter. Include it with app.include_router(router) (no prefix)."""
    base = base_path.rstrip("/")
    router = APIRouter()
    db = sqlite3.connect(db_path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    lock = threading.Lock()
    db.execute(
        """CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        type TEXT NOT NULL, severity TEXT NOT NULL, summary TEXT NOT NULL,
        payload TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')"""
    )
    db.commit()
    windows = {}

    def limited(ip):
        now = time.time()
        if len(windows) > 10000:
            for k in [k for k, v in windows.items() if now - v[0] > 60]:
                del windows[k]
        w = windows.get(ip)
        if not w or now - w[0] > 60:
            w = [now, 0]
            windows[ip] = w
        w[1] += 1
        return max(1, int(60 - (now - w[0]) + 0.999)) if w[1] > rate_limit_per_minute else 0

    def client_ip(request):
        if trust_proxy:
            xf = request.headers.get("x-forwarded-for")
            if xf:
                return xf.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def row(r):
        return {
            "id": r["id"], "created_at": r["created_at"], "status": r["status"], "type": r["type"],
            "severity": r["severity"], "summary": r["summary"], "note": r["note"],
            "payload": json.loads(r["payload"]), "untrusted": True,
        }

    def admin_ok(request):
        if not admin_token:
            return False
        m = re.match(r"^Bearer (.+)$", request.headers.get("authorization", ""))
        return bool(m) and hmac.compare_digest(m.group(1).encode(), admin_token.encode())

    unauthorized = lambda: _json(401, {"error": "admin token required"}, {"WWW-Authenticate": "Bearer"})

    @router.get("/.well-known/feedback.json", include_in_schema=False)
    def discovery():
        return _json(200, {
            "version": "1", "feedback_endpoint": base, "method": "POST",
            "content_type": "application/json", "schema_url": base + "/schema",
            "max_body_bytes": max_body_bytes, "rate_limit_per_minute": rate_limit_per_minute,
            "description": "Send structured feedback (bug, missing feature, confusing error) about this API. "
                           "A human reviews it. Text is treated as untrusted data.",
        })

    @router.get(base + "/schema", include_in_schema=False)
    def schema():
        return _json(200, SCHEMA)

    @router.post(base, include_in_schema=False)
    async def submit(request: Request):
        ct = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if ct != "application/json":
            return _json(415, {"error": "content-type must be application/json"})
        wait = limited(client_ip(request))
        if wait:
            return _json(429, {"error": "rate limit exceeded", "retry_after_seconds": wait}, {"Retry-After": str(wait)})
        try:
            raw = await _read_body(request, max_body_bytes)
        except _TooLarge:
            return _json(413, {"error": f"body exceeds {max_body_bytes} bytes"})
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(400, {"error": "invalid JSON"})
        value, errors = validate(parsed)
        if errors:
            return _json(400, {"error": "validation failed", "details": errors})
        with lock:
            if db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0] >= max_rows:
                return _json(503, {"error": "feedback storage is full"})
            fid = "fb_" + secrets.token_hex(8)
            db.execute(
                "INSERT INTO feedback (id, created_at, status, type, severity, summary, payload) VALUES (?,?,?,?,?,?,?)",
                (fid, datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                 "new", value["type"], value["severity"], value["summary"], json.dumps(value)),
            )
            db.commit()
        return _json(201, {"id": fid, "status": "received"})

    @router.get(base + "/admin", include_in_schema=False)
    def dashboard():
        return HTMLResponse(DASHBOARD, headers={
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                                       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})

    @router.get(base + "/admin/api/stats", include_in_schema=False)
    def stats(request: Request, days: int = 30):
        if not admin_ok(request):
            return unauthorized()
        days = min(max(days, 1), 365)
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with lock:
            rows = db.execute("SELECT created_at, status, type, severity, payload FROM feedback WHERE created_at >= ?", (since,)).fetchall()
        return _json(200, compute_stats(
            [{**dict(r), "payload": json.loads(r["payload"])} for r in rows], days))

    @router.get(base + "/admin/api/items", include_in_schema=False)
    def list_items(request: Request, status: str = "", limit: int = 100):
        if not admin_ok(request):
            return unauthorized()
        if status and status not in STATUSES:
            return _json(400, {"error": "bad status filter"})
        limit = min(max(limit, 1), 500)
        with lock:
            if status:
                rows = db.execute("SELECT * FROM feedback WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?", (status, limit)).fetchall()
            else:
                rows = db.execute("SELECT * FROM feedback ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
        return _json(200, {"items": [row(r) for r in rows]})

    @router.get(base + "/admin/api/items/{item_id}", include_in_schema=False)
    def get_item(item_id: str, request: Request):
        if not admin_ok(request):
            return unauthorized()
        with lock:
            r = db.execute("SELECT * FROM feedback WHERE id=?", (item_id,)).fetchone()
        return _json(200, row(r)) if r else _json(404, {"error": "not found"})

    @router.patch(base + "/admin/api/items/{item_id}", include_in_schema=False)
    async def patch_item(item_id: str, request: Request):
        if not admin_ok(request):
            return unauthorized()
        with lock:
            r = db.execute("SELECT * FROM feedback WHERE id=?", (item_id,)).fetchone()
        if not r:
            return _json(404, {"error": "not found"})
        try:
            b = json.loads((await _read_body(request, max_body_bytes)).decode("utf-8"))
        except (_TooLarge, ValueError, UnicodeDecodeError):
            return _json(400, {"error": "invalid JSON"})
        if not isinstance(b, dict):
            return _json(400, {"error": "body must be an object"})
        if "status" in b and b["status"] not in STATUSES:
            return _json(400, {"error": "status must be one of: " + ", ".join(STATUSES)})
        if "note" in b and (not isinstance(b["note"], str) or len(b["note"]) > 2000):
            return _json(400, {"error": "note must be a string of at most 2000 characters"})
        with lock:
            db.execute("UPDATE feedback SET status=?, note=? WHERE id=?",
                       (b.get("status", r["status"]), _clean(b["note"]) if "note" in b else r["note"], item_id))
            db.commit()
            r = db.execute("SELECT * FROM feedback WHERE id=?", (item_id,)).fetchone()
        return _json(200, row(r))

    return router

# SuperFeedback

A `/feedback` endpoint you add to your backend in a few lines, so AI agents that hit a bug or a missing feature can say so in a structured way. A human reviews what comes in.

Idea origin: Brian Armstrong's post, "Every backend service should have a /feedback endpoint." This repo is v1 of that idea. It is small on purpose.

## What it does

- `POST /feedback` accepts one strict JSON shape (see `spec/feedback.schema.json`).
- `GET /.well-known/feedback.json` tells an agent where the endpoint is and how to call it.
- `GET /feedback/schema` returns the JSON schema.
- `GET /feedback/admin` is a small review page. It needs an admin token. You can mark each item new, triaged, accepted, rejected or done, and add a note. The top of the page shows what agents struggle with: top endpoint + type pairs, counts by type, severity, agent and day (also at `GET /feedback/admin/api/stats?days=30`).
- Storage is SQLite. No other services.
- Two implementations with the same behavior: Express middleware (`node/`) and a FastAPI router (`python/`).

## Not done yet

- **No auto-PR, no patch drafting, no sandbox testing, no docs updater.** Nothing here writes code or opens pull requests. By design for v1: humans read the reports and decide.
- No dedupe of similar reports, no email or Slack alerts, no per-agent API keys.
- Rate limiting is in memory, per client IP, per process. Behind a proxy set `trustProxy` / `trust_proxy`, and use a real limiter at the edge for production.
- Single admin token, no user accounts.
- Not published to npm or PyPI. Install from this repo.
- Only tested with the test suites and a local run of both example servers. The dashboard was run in jsdom against a live server (stats and items render, an `<img onerror>` payload shows as plain text), but not opened in a real browser.

## Run it

### Express (Node 22.5 or newer)

```sh
cd node
npm install
FEEDBACK_ADMIN_TOKEN=pick-a-long-random-string PORT=3000 node examples/server.js
```

In your own app:

```js
const { feedback } = require('./node');   // or copy node/ into your project
app.use(feedback({ dbPath: 'feedback.db', adminToken: process.env.FEEDBACK_ADMIN_TOKEN }));
```

The middleware uses Node's built-in `node:sqlite`, which prints an experimental warning on Node 22. Use `node --no-warnings` to hide it.

### FastAPI (Python 3.9 or newer)

```sh
cd python
pip install -e . uvicorn
FEEDBACK_ADMIN_TOKEN=pick-a-long-random-string uvicorn examples.app:app --port 3000
```

In your own app:

```python
from superfeedback import create_feedback_router
app.include_router(create_feedback_router(db_path="feedback.db", admin_token=os.environ["FEEDBACK_ADMIN_TOKEN"]))
```

### Try it as an agent

```sh
python examples/agent_client.py http://localhost:3000
```

Then open `http://localhost:3000/feedback/admin`, paste your admin token, and click Load. If you do not set an admin token, the review API is off.

## The submission

```json
{
  "type": "bug",
  "summary": "POST /users returns 500 when last_name is null",
  "details": "optional, up to 4000 chars",
  "severity": "low | medium | high",
  "expected": "optional", "actual": "optional", "suggestion": "optional",
  "context": { "method": "POST", "path": "/users", "status_code": 500, "error_message": "..." },
  "agent": { "name": "my-agent", "version": "1.2" }
}
```

`type` is one of `bug`, `missing_feature`, `confusing_error`, `docs`, `performance`, `other`. Only `type` and `summary` are required. Unknown fields are rejected with a 400 that lists each problem.

Responses: `201 {"id", "status": "received"}`, `400` validation, `413` body too large (default 16 KB), `415` wrong content type, `429` rate limited (with `Retry-After`, default 30 per minute per IP), `503` storage full (default 50,000 rows).

## Safety notes

Anyone can send text to this endpoint, so treat every field as hostile.

- Text is stored as plain data. Control characters are stripped, sizes are capped, and the dashboard renders with `textContent` plus a strict Content-Security-Policy.
- Items returned by the review API carry `"untrusted": true`.
- **If you later feed this text to a coding agent, that is a prompt-injection path.** Keep a human between a report and any code change, and show the agent the report as quoted data, not as instructions.
- The admin token is compared in constant time and is sent only in an `Authorization` header. Serve the dashboard over HTTPS.

## Tests

```sh
cd node && npm test          # 10 tests
cd python && pip install -e ".[test]" && pytest -q   # 23 tests
sh scripts/check-sync.sh     # the dashboard and schema are copied into both packages
```

## License

MIT

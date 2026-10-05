"""What an AI agent does: discover the endpoint, then submit feedback. Stdlib only.
Usage: python examples/agent_client.py http://localhost:3000
"""
import json
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:3000"
disc = json.load(urllib.request.urlopen(base + "/.well-known/feedback.json"))
req = urllib.request.Request(
    base + disc["feedback_endpoint"],
    data=json.dumps({
        "type": "missing_feature",
        "summary": "GET /users has no pagination parameter",
        "details": "Listing returns everything; I need to page through results.",
        "suggestion": "Add ?limit= and ?cursor=",
        "context": {"method": "GET", "path": "/users", "status_code": 200},
        "agent": {"name": "example-agent", "version": "0.1"},
    }).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    print(json.load(urllib.request.urlopen(req)))
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())
    sys.exit(1)

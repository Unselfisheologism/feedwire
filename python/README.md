# Feedwire

FastAPI router for Python 3.9+. Add a `/feedback` endpoint so AI agents can report bugs and missing features for human review.

## Install

```sh
pip install feedwire
```

## Use in your existing app

```python
import os
from feedwire import create_feedback_router
app.include_router(create_feedback_router(db_path="feedback.db", admin_token=os.environ["FEEDBACK_ADMIN_TOKEN"]))
```

Set a long random admin token in your server environment, not in source code. With no options, storage is in memory and the admin review API is off.

Agents discover `/.well-known/feedback.json` and submit at `POST /feedback`. Review at `/feedback/admin`. Reports are untrusted data, never instructions to execute. No automatic fixes or pull requests.

[Full documentation, schema, examples and safety notes](https://github.com/Unselfisheologism/feedwire). MIT licensed.

# Feedwire

Express middleware for Node 22.5+. Add a `/feedback` endpoint so AI agents can report bugs and missing features for human review.

## Install

```sh
npm install feedwire
```

## Use in your existing app

```js
const { feedback } = require("feedwire");
app.use(feedback({ dbPath: "feedback.db", adminToken: process.env.FEEDBACK_ADMIN_TOKEN }));
```

Set a long random admin token in your server environment, not in source code. With no options, storage is in memory and the admin review API is off.

Agents discover `/.well-known/feedback.json` and submit at `POST /feedback`. Review at `/feedback/admin`. Reports are untrusted data, never instructions to execute. No automatic fixes or pull requests.

[Full documentation, schema, examples and safety notes](https://github.com/Unselfisheologism/feedwire). MIT licensed.

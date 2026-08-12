# SwarmReview Data Layer (`db/`)

Zero-dependency Node service implementing the frozen contract in
[`schema.md`](schema.md) — REST + SSE over SQLite (built-in `node:sqlite`).

## Run

```bash
node server.js
```

- Default port `4821` (override with `SWARMREVIEW_PORT`).
- Default DB file `./swarmreview.db` (override with `SWARMREVIEW_DB`).
- Applies `schema.sql` (idempotent) on startup.

## Verify

```bash
curl -s http://127.0.0.1:4821/healthz          # {"ok":true}
curl -s -X POST http://127.0.0.1:4821/hunks \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"review-tool-ao-2","agentName":"opencode","filePath":"src/main.ts","diffText":"@@ -1 +1 @@\n","summary":"test"}'
curl -s http://127.0.0.1:4821/hunks?status=pending
curl -s http://127.0.0.1:4821/stats
curl -sN http://127.0.0.1:4821/events         # SSE feed
```

## Ownership

This folder is owned by the Data Layer (component 2). Other components (listener, slackbot,
router, dashboard) read `schema.md` as the frozen contract but must not edit files here.

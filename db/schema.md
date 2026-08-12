# SwarmReview Data Layer — Frozen Interface Contract (v1)

> **Status: FROZEN.** Do not change these types/endpoints without re-freezing with the
> orchestrator. All four parallel components (listener, slackbot, router, dashboard) build
> against THIS file. Each component owns its folder and may only talk to the other components
> through this API.

The Data Layer is a tiny local service (SQLite + REST + SSE). It is the **only** shared
interface between components:

- **Listener** writes hunks → `POST /hunks` (never touches Slack/AO UI).
- **Slackbot** reads hunks → `GET /hunks` and writes decisions → `POST /decisions`
  (never touches AO directly).
- **Router** subscribes to decisions → `GET /events` (SSE) and reads hunks → `GET /hunks/:id`
  (never touches Slack).
- **Dashboard** reads stats → `GET /stats`, `GET /sessions`, `GET /hunks` (read-only).

---

## 1. Core types (frozen)

```ts
type HunkStatus = "pending" | "approved" | "rejected" | "needs_revision";

type Hunk = {
  id: string;            // stable id, e.g. sha256(sessionId|filePath|diffText)-NN, unique
  sessionId: string;     // AO session id, e.g. "review-tool-ao-2"
  agentName: string;     // AO harness/display name, e.g. "opencode"
  filePath: string;      // repo-relative path, e.g. "src/main.ts"
  diffText: string;      // unified diff snippet for THIS hunk only
  summary: string;       // one-line human summary of the change
  status: HunkStatus;
  createdAt: string;     // ISO-8601 UTC
  updatedAt: string;     // ISO-8601 UTC
};

type DecisionAction = "approve" | "reject" | "revise";

type Decision = {
  id: string;            // unique decision id
  hunkId: string;        // FK -> Hunk.id
  action: DecisionAction;
  comment?: string;      // required for "revise" (and recommended for "reject")
  decidedAt: string;     // ISO-8601 UTC
};

type SessionRow = {
  id: string;            // AO session id (PK)
  agentName: string;     // harness/display name
  branch: string;        // AO git branch for the session worktree
  firstSeenAt: string;
  lastUpdatedAt: string;
};
```

### Status transitions (enforced by Data Layer)
`pending` → `approved` | `rejected` | `needs_revision` (on `POST /decisions`)
`needs_revision` → `pending` (on revision round-trip; optional for v1 cut)
No other transitions. Duplicate decisions on the same hunk are rejected (409).

---

## 2. REST API (frozen)

Base URL: `http://127.0.0.1:4821` (port configurable via `SWARMREVIEW_PORT` env; default 4821).
All request/response bodies are JSON. Errors: `{"error":{"code":"...","message":"..."}}`.

### `POST /hunks` — Listener publishes a new hunk
Request:
```json
{
  "sessionId": "review-tool-ao-2",
  "agentName": "opencode",
  "filePath": "src/main.ts",
  "diffText": "@@ -1,5 +1,6 @@\n ...",
  "summary": "Add retry to http client",
  "id": "optional-client-supplied-id"
}
```
Response `201`: the created `Hunk` (`status: "pending"`).
`409`: hunk with same `id` already exists (returns existing body).
Idempotent by `id` — re-posting the same hunk returns `200` with the existing row.

### `GET /hunks?status=pending&sessionId=...&agentName=...&filePath=...` — read hunks
Query params optional; combine with `&`. Response:
```json
{ "hunks": [ Hunk, ... ] }
```
Default (no params): all hunks, newest first.

### `GET /hunks/:id` — single hunk
Response: the `Hunk`. `404` if unknown.

### `POST /decisions` — Slackbot records a human decision
Request:
```json
{ "hunkId": "abc123", "action": "approve", "comment": "optional" }
```
Response `201`:
```json
{
  "decision": { "id": "...", "hunkId": "abc123", "action": "approve", "comment": "...", "decidedAt": "..." },
  "hunk": { /* the updated Hunk with new status */ }
}
```
Behavior: sets `hunk.status` per table below, bumps `hunk.updatedAt`, appends decision row.
`409` if hunk already has a decision (status != pending). `422` if `action=revise` and no comment.
`404` if hunk unknown.

### `GET /decisions?hunkId=...&action=...` — read decisions
Response: `{ "decisions": [ Decision, ... ] }` newest first.

### `GET /sessions` — session registry (upserted on hunk POST)
Response: `{ "sessions": [ SessionRow, ... ] }`.

### `GET /stats` — dashboard aggregate
Response:
```json
{
  "totalHunks": 12, "pending": 5, "approved": 4, "rejected": 2, "needsRevision": 1,
  "byAgent": [ { "agentName": "opencode", "pending": 3, "approved": 2, "rejected": 1, "needsRevision": 0 } ],
  "bySession": [ { "sessionId": "review-tool-ao-2", "pending": 5, "approved": 4, "rejected": 2, "needsRevision": 1 } ]
}
```

### `GET /healthz`
`{"ok":true}`

---

## 3. Event feed (SSE) — Router subscription (frozen)

### `GET /events?types=decision,hunk` — Server-Sent Events stream
Listener components subscribe to relevant events:
- `event: hunk` → `data: {"hunk": Hunk}` (fires on `POST /hunks`)
- `event: decision` → `data: {"decision": Decision, "hunk": Hunk}` (fires on `POST /decisions`)

The Router subscribes to `types=decision` and processes each event (resolve hunk → worktree →
git apply / reverse-apply / steer-agent per `../router/README.md`).

Retries: standard SSE `retry: 3000`. Events are also replayed from the start of the stream;
consumers must dedupe by `decision.id` / `hunk.id`.

---

## 4. SQLite schema (frozen — implemented in `db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent_name      TEXT NOT NULL DEFAULT '',
  branch          TEXT NOT NULL DEFAULT '',
  first_seen_at   TEXT NOT NULL,
  last_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunks (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  diff_text  TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','approved','rejected','needs_revision')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hunks_status ON hunks (status);
CREATE INDEX IF NOT EXISTS idx_hunks_session ON hunks (session_id);

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  hunk_id    TEXT NOT NULL REFERENCES hunks (id),
  action     TEXT NOT NULL CHECK (action IN ('approve','reject','revise')),
  comment    TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_hunk ON decisions (hunk_id);
```

---

## 5. Files owned by the Data Layer (`db/`)

| File | Purpose |
|---|---|
| `schema.md` | This contract (frozen). |
| `schema.sql` | DDL above (frozen). |
| `server.js` | Node HTTP+SSE+SQLite service implementing the API (port 4821). |
| `package.json` | Zero-dependency Node (uses built-in `node:sqlite`, `node:http`). |
| `README.md` | Run instructions (`node server.js`). |

**Ownership rule:** only the Data Layer may write to `db/`. Other components read this contract
but must not edit `db/` files.

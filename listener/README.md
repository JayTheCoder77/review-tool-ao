# SwarmReview — AO Event Listener (`listener/`)

> **⚠️ READ THIS FIRST (AO integration research, verified live against the installed AO daemon):**
> How to read live AO session diffs/hunks. All findings below were verified by querying the
> running local AO daemon on this machine (single Go binary `ao daemon` inside the AppImage,
> data dir `~/.ao/data`, SQLite `~/.ao/data/ao.db`). The daemon exposes a plain HTTP API on
> `http://127.0.0.1:3001` with **no auth required** (localhost-only). Port is overridable with
> `AO_PORT` env var (validated range 1–65535).

## AO daemon REST API — reading live session diffs

The daemon serves a REST API under `/api/v1`. The relevant routes (confirmed live):

### Iterate sessions
- `GET /api/v1/sessions` → `{"sessions":[{"id","projectId","kind":"worker|orchestrator","harness","mode","activity":{"state","lastActivityAt"},"isTerminated","branch","prs":[...]}] }`
  - `kind` distinguishes workers (`worker`) from orchestrators. Only listen to workers.
  - `branch` is the session's git branch (e.g. `ao/review-tool-ao-2/root`).
  - `prs` lists claimed PR facts for the session.
- `GET /api/v1/sessions/{sessionId}` → single session detail.
- `GET /api/v1/projects` → project registry `{"projects":[{"id","name","path","kind"}]}`. The
  `path` is the canonical checkout; each session runs in a git **worktree** under
  `~/.ao/data/worktrees/<project-id>/<session-id>/` (confirmed: the session worktree exists and
  matches the `branch`).

### Session diffs / files (THE hunk source — verified live)
- `GET /api/v1/sessions/{sessionId}/workspace/files` →
  ```json
  {"sessionId":"...","compareBaseSha":"<base-sha>","compareBaseRef":"origin/main","compareMode":"base",
   "files":[{"path":"README.md","status":"added|modified|deleted|unmodified","additions":N,"deletions":N,"size":N,"binary":false}]}
  ```
  `status` is per-file against the session's diff base (`compareBaseSha`, usually `origin/main`).
  This is how the desktop UI detects changed files — no hunk endpoint exists.
- `GET /api/v1/sessions/{sessionId}/workspace/file?path=<relative-path>` → per-file detail:
  ```json
  {"sessionId":"...","path":"...","status":"modified","additions":N,"deletions":N,"content":"<current file content>",
   "diff":"diff --git a/... b/...\nindex ...\n--- a/...\n+++ b/...\n@@ ... @@\n...", "compareBaseSha":"...","compareMode":"base"}
  ```
  The `diff` field is a full **unified git diff** for that file (verified live: appending a line
  to `README.md` immediately showed `status:"modified"` and a valid `diff --git` payload in the
  response). **This is what the Listener splits into hunks.**

### Live change notifications (no webhook; use SSE polling)
- `GET /api/v1/events` → global **Server-Sent Events** stream. Emits `event: session_created`,
  `event: session_updated`, `event: pr_created`, `event: pr_updated`, `event: pr_check_recorded`
  (verified live: the stream replays session lifecycle events with `id`, `event`, `data` fields).
  Use this to detect "new/changed sessions" cheaply.
- `GET /api/v1/sessions/{sessionId}/workspace/events` → SSE stream of `event: workspace_changed`
  for one session (verified live; fires when the session's worktree files change).
- Fallback (always works): poll `GET /api/v1/sessions` + per-session
  `GET .../workspace/files` on a timer (e.g. every 5–15 s) and hash the file list / diff text
  to detect changes. Because there is no hunk-level endpoint, the Listener must diff the
  `workspace/files` (and `workspace/file?path=` `diff` payloads) itself.

### Data model note
- Session diffs are git diff text computed against `compareBaseSha`; there is **no** per-hunk
  machine ID on the daemon side. The `hunkId` in the SwarmReview contract must therefore be
  computed/deduped by the Listener (e.g. `sha256(sessionId|filePath|diffText)-k` hashed and
  re-derived stably, since hunks can be grouped by file-diff sections and numbered).

## What the Listener does (see `specification.md` / root prompt)

1. Watch the AO daemon API for workers (poll `GET /api/v1/sessions` and/or subscribe to
   `GET /api/v1/events`, then `GET .../workspace/files` per session).
2. For each changed file, fetch `GET .../workspace/file?path=` and split its `diff` field into
   hunks: `{ sessionId, agentName, filePath, hunkId, diffText, summary, status:"pending" }`.
   `agentName` is the session `id` (or `displayName`/`harness` from `GET /api/v1/sessions`).
3. Deduplicate so an unchanged hunk is not republished on every poll (stable hunkId from content
   hash + file, and skip hunks whose file+diff hash already exists in the DB).
4. `POST /hunks` to the Data Layer (see `../db/schema.md`). **Never talks to Slack.**

Concurrency guard: keep at most one poll cycle per session in flight; use the `change_log`,
or just compare the previous file-status hash for each session — no daemon-side revision
counter exists.
# SwarmReview — Router (`router/`)

> **⚠️ READ THIS FIRST (AO integration research, verified live against the installed AO daemon):**
> How to programmatically commit or discard a specific hunk in an AO agent session. All findings
> below were verified by querying the running local AO daemon on this machine. The daemon is a
> single Go binary (`ao daemon` inside the AppImage), data dir `~/.ao/data`, SQLite `~/.ao/data/ao.db`,
> plain HTTP API on `http://127.0.0.1:3001` with **no auth** (localhost-only; port overridable with
> `AO_PORT`).

## TL;DR — what the Router can and cannot do with the AO API

- **There is no AO endpoint to "commit a hunk" or "discard a hunk" by ID.** Hunks do not exist
  on the daemon side — a "hunk" is a git-diff section the Listener extracted from a session's
  workspace diff. So the Router drives hunks through **git operations on the session's worktree**
  plus **session steering/messaging via the daemon API**.
- Each AO worker runs in its own git **worktree** at `~/.ao/data/worktrees/<project-id>/<session-id>/`
  on branch `<session.branch>` (confirmed live). The Router can `git apply`/`git checkout`/`git
  commit` inside that worktree directly to commit or discard a hunk — that is the authoritative
  programmatic mechanism. The daemon exposes no such git primitive, so do not look for one.
- To steer the originating agent (e.g. "needs_revision" with a comment), the daemon API offers
  message injection — this is how a human comment becomes new instructions for the agent.

## Verified daemon API surface relevant to the Router

### Read sessions + worktrees
- `GET /api/v1/sessions` → `{"sessions":[{"id","projectId","kind":"worker|orchestrator","harness","branch","prs":[...]}]}`
- `GET /api/v1/projects` → `{"projects":[{"id","name","path"}]}` — `path` is the canonical repo;
  worker worktrees live at `~/.ao/data/worktrees/<projectId>/<sessionId>/` (confirmed by
  inspecting the live session worktree; the daemon also stores them in its `session_worktrees`
  table with `worktree_path`, `branch`, `base_sha`, `state`).

### Send a message to a session (steer the agent) — VERIFIED LIVE
- `POST /api/v1/sessions/{sessionId}/send` body `{"message":"<text>"}` → `{"ok":true,...}`.
  Verified against a live session. This is exactly what the `ao send` CLI wraps
  (`ao send --session <id> --message "<text>"`). Use this to:
  - re-prompt the agent with the reviewer comment on "needs_revision";
  - ask the agent to commit/revise after a hunk decision.
- `POST /api/v1/sessions/{sessionId}/conversation/steer` → `{"steerText":"<text>"}` for chat-mode
  sessions only; TUI-mode sessions (the default here) return `SESSION_MODE_MISMATCH`
  ("created in Terminal UI mode and has no chat conversation") — confirmed live. Prefer `/send`.

### Merge / PR lifecycle (relevant for "approved hunks get committed by AO")
- `POST /api/v1/prs/{id}/merge` → merges a PR (PR facts come from `GET /api/v1/sessions` → `prs`).
- `POST /api/v1/sessions/{sessionId}/rollback` and
  `POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/rollback` exist but are turn
  rollbacks, not hunk discards — not the primary mechanism.

## How the Router applies a decision (recommended flow)

A decision arrives from the Data Layer: `{ hunkId, action: "approve"|"reject"|"revise", comment? }`.

The Router resolves `hunkId` → hunk record (Data Layer `GET /hunks/:id`) to get
`sessionId`, `filePath`, `diffText`. The session's worktree is
`~/.ao/data/worktrees/<projectId>/<sessionId>/` (projectId from the session record or
`GET /api/v1/projects`). Then:

1. **approve** — commit the hunk into the session worktree:
   ```
   cd <session-worktree>
   git apply --cached <hunk>.patch   # stage only this hunk's diff
   git commit -m "swarmreview: apply hunk <hunkId> (approved)"
   ```
   Build `<hunk>.patch` from `hunk.diffText` (unified diff — as returned by
   `GET .../workspace/file?path=`). Prefer `git apply --cached` then `git commit` so only the
   hunk is committed and the agent's own working state stays intact. The session's PR (if any)
   then picks up the commit on its branch; optionally `POST /api/v1/prs/{id}/merge`.
   Do **not** amend/force-push the agent's branch.

2. **reject** — discard the hunk from the session worktree:
   ```
   cd <session-worktree>
   git apply -R <hunk>.patch          # reverse-apply exactly this hunk
   ```
   If the agent changed the same file afterwards, the reverse apply may conflict — in that case
   fall back to telling the agent via `/send` ("discard this change: <filePath>") and let the
   agent resolve. Never `git reset --hard` the whole worktree (destroys the agent's other work).

3. **revise** — re-prompt the agent:
   ```
   POST /api/v1/sessions/<sessionId>/send  {"message": "Reviewer feedback: <comment>"}
   ```
   (plus a clear instruction: "Please revise <filePath> accordingly and re-propose."). Optionally
   also reverse-apply the hunk first so the agent starts from a clean slate.

## Concurrency / safety notes

- Resolve hunk→session→worktree once per decision; a session maps to exactly one worktree for a
  single-repo project (`session_worktrees` table: one row per (session_id, repo_name)).
- Guard against double-processing with an idempotency check on the Data Layer (hunk status must
  still be pending/needs_revision when the Router picks it up; the Data Layer flips status on
  `POST /decisions`).
- The Router should subscribe to the Data Layer's decision feed (see `../db/schema.md`) rather
  than poll: the Data Layer exposes an SSE/streaming endpoint for new `decisions` rows.
- **The Router only ever talks to AO (daemon API + git) and the Data Layer API — never Slack.**

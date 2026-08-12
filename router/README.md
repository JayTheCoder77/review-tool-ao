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

---

# Implementation (`router/` — component 4)

Zero-dependency Node (Node ≥ 22, built-ins only: `node:http`, `node:child_process`,
`node:fs`, global `fetch`). The Router talks **only** to the Data Layer API, the AO daemon
API, and git on session worktrees. It never talks to Slack.

## Files

| File | Purpose |
|---|---|
| `router.js` | Main loop: SSE subscription + poll fallback + dedupe + state persistence. |
| `demo.js` | Self-test / live demo (see below). |
| `lib/processor.js` | Decision orchestration: resolve hunk → worktree → dispatch approve/reject/revise. |
| `lib/datalayer.js` | Data Layer client (`GET /hunks/:id`, `GET /decisions`, `GET /events` SSE). |
| `lib/ao.js` | AO daemon client (`GET /api/v1/sessions`, `GET /api/v1/projects`, `POST /api/v1/sessions/{id}/send`). |
| `lib/worktree.js` | Session → worktree resolution (`~/.ao/data/worktrees/<projectId>/<sessionId>/` + overrides). |
| `lib/git.js` | `git apply --cached` / `git commit` / `git apply -R` helpers (never amend / force-push / `reset --hard`). |
| `lib/sse.js` | Minimal SSE consumer (node:http). |
| `lib/http.js` | Tiny JSON GET/POST helpers (global fetch). |
| `.router-state.json` | Runtime state (processed decision ids) — created on first run, gitignored. |

## How a decision flows through the Router

1. **Subscribe** — `GET /events?types=decision` (SSE, `event: decision`). As a fallback the
   router also **polls `GET /decisions`** every `SWARMREVIEW_POLL_INTERVAL_MS` (15 s default)
   and runs a catch-up poll at startup, so decisions made while the router was offline are
   still handled. Every decision id is recorded in `.router-state.json` and deduped in memory,
   so SSE replays and poll overlap never double-process a decision.
2. **Resolve the hunk** — `GET /hunks/:hunkId` → `sessionId`, `filePath`, `diffText`.
3. **Resolve the worktree** — session → `projectId` (`GET /api/v1/sessions`, else project
   prefix-inference via `GET /api/v1/projects`) → `~/.ao/data/worktrees/<projectId>/<sessionId>/`.
   (Demo/testing can override with a `sessionId → path` map, see env table.)
4. **Dispatch** (all git ops run inside the session worktree, on the session branch):

   | action | what the Router does |
   |---|---|
   | `approve` | `git apply --cached <hunk>.patch` (stages **only** this hunk; falls back to `--3way`), then `git commit -m "swarmreview: apply hunk <id> (approved)"` (only the hunk — commit is restricted to the hunk's path if other files are pre-staged; never amend, never force-push). Optionally notifies the agent via `POST /api/v1/sessions/{id}/send`. |
   | `reject` | `git apply -R <hunk>.patch` reverse-applies the hunk off the working tree (falls back to `-R --3way`). If the file moved on afterwards and the reverse-apply conflicts, the Router messages the agent via `/send` telling it to discard that change itself. Never `reset --hard`. |
   | `revise` | (default) reverse-applies the hunk first so the agent starts from a clean slate, then `POST /api/v1/sessions/{id}/send` with `Reviewer feedback: <comment>` + “please revise <filePath> and re-propose”. |

   When an apply/commit fails (e.g. the agent already committed the change, or edited the file
   further) the Router **steers the agent via `/send`** instead of silently leaving the hunk
   un-applied, so no human decision is lost.

## Run

```bash
node router.js
```

Default expectations: Data Layer on `http://127.0.0.1:4821`, AO daemon on
`http://127.0.0.1:3001`. Run `node demo.js` first to confirm the pipeline works.

### Env

| Env | Default | Purpose |
|---|---|---|
| `SWARMREVIEW_DATA_URL` | `http://127.0.0.1:4821` | Data Layer base (or `SWARMREVIEW_PORT`). |
| `AO_API_URL` | `http://127.0.0.1:3001` | AO daemon base (or `AO_PORT`). |
| `SWARMREVIEW_STATE_FILE` | `./router/.router-state.json` | Processed-decision state file. |
| `SWARMREVIEW_POLL_INTERVAL_MS` | `15000` | Poll fallback interval (`0` disables periodic polling; startup catch-up poll always runs). |
| `SWARMREVIEW_SSE_RETRY_MS` | `3000` | SSE reconnect delay. |
| `SWARMREVIEW_AO_WORKTREES_ROOT` | `~/.ao/data/worktrees` | Worktree base dir. |
| `SWARMREVIEW_WORKTREE_OVERRIDES` | — | `"sessionId=/path/to/worktree;..."` (demo/testing). |
| `SWARMREVIEW_ONCE` / `--once` | off | Poll once, process, exit (cron/CI). |
| `SWARMREVIEW_DRY_RUN=1` | off | Log decisions; touch neither git nor the daemon. |
| `SWARMREVIEW_QUIET=1` | off | Less chatter. |
| `SWARMREVIEW_GIT_AUTHOR_NAME` / `_EMAIL` | `SwarmReview Router` / `router@swarmreview.local` | Identity used only when a worktree has no git identity configured. |

## Self-test / demo

```bash
node demo.js          # 15 assertions across approve / reject / revise / SSE
```

`demo.js` spins up a scratch git worktree (a simulated AO session workspace), then walks the
real end-to-end path against the live Data Layer API (`http://127.0.0.1:4821`; falls back to
a scratch instance if it is down):

1. **approve** — posts a hunk, posts an `approve` decision, and the Router processor stages it
   (`git apply --cached`) and commits it; verified via the scratch repo's commit log, file
   content, and clean working tree.
2. **reject** — posts a second hunk + `reject` decision; verified the file is reverse-applied
   (`git apply -R`) back to its prior content with no new commit.
3. **revise** — posts a third hunk + `revise` decision with a comment; verified the hunk is
   reverse-applied (clean slate) and the reviewer comment is handed to
   `POST /api/v1/sessions/{id}/send` (the demo session id doesn't exist on the real daemon, so
   the 404 is expected and reported).
4. **SSE** — subscribes to `GET /events` before any decision is posted and asserts all three
   decisions arrive on the `decision` event feed (proves the same subscription path
   `router.js` uses).

The demo uses `SWARMREVIEW_WORKTREE_OVERRIDES` (programmatic equivalents) so it never touches
real AO sessions. Exit code is 0 only when all assertions pass.

## Verified live

- Approve/reject/revise flows pass end-to-end through `router.js` against the live Data Layer
  with a scratch worktree (commit created / change reverted / agent messaged).
- SSE `decision` events are received and deduped; processed ids persist across restarts
  (restart reprocesses nothing).
- Worktree resolution works against the live AO daemon: a real session resolves to
  `~/.ao/data/worktrees/<projectId>/<sessionId>/`; unknown sessions are prefix-matched to a
  project and reported clearly when the worktree is missing.

## Known gaps / notes

- The `/send` success path is exercised only up to the daemon boundary in the demo (demo
  session ids don't exist on the daemon → expected 404). With a real AO worker session running,
  the same code path injects the message (the daemon endpoint itself was verified live per the
  research at the top of this file).
- Multi-hunk diffs: `git apply` operates on the whole diffText of a hunk. If a listener ever
  publishes a hunk whose diffText covers more than one file, approve commits all of those
  files' staged lines (paths beyond `filePath` are committed explicitly; cross-file hunks are
  not split here).
- If an agent has staged unrelated changes in its worktree, approve commits only the hunk's
  path (see `commitHunk`), keeping the agent's other staged work intact.
- `revise` reverse-apply is best-effort: if it conflicts, the agent is still steered with the
  comment (the hunk is not left half-applied).

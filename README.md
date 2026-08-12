# review-tool-ao — SwarmReview

A human-in-the-loop review layer for AO agent swarms. When multiple AO agents work in parallel,
each proposed change is collected into hunks, reviewed per-hunk in a single Slack digest, and
each decision (approve / reject / revise) is routed back to the originating AO agent so it can
commit, revise, or discard automatically.

Full architecture + build spec: [`swarm-review-bot-prompt.md`](swarm-review-bot-prompt.md).

## Components

| Folder | Component | Role |
|---|---|---|
| [`db/`](db/) | Data Layer (frozen contract) | SQLite + REST + SSE. The only shared interface. See [`db/schema.md`](db/schema.md). |
| [`listener/`](listener/) | AO Event Listener | Watches AO daemon, normalizes session diffs into hunks, `POST /hunks`. |
| [`slackbot/`](slackbot/) | Digest Builder + Slack Bot | Posts hunks as collapsible Slack blocks with per-hunk Approve/Reject/Comment buttons; records decisions. |
| [`router/`](router/) | Router | Subscribes to decisions; commits/discards hunks in AO session worktrees and steers agents. |
| [`dashboard/`](dashboard/) | Dashboard (stretch) | Web page showing swarm review status (pending/approved/rejected per agent). |

Component ownership: each folder is owned by exactly one component. Components talk to each
other **only** through the Data Layer API ([`db/schema.md`](db/schema.md)).

## Run

1. Data Layer: `cd db && node server.js` (default port 4821; see [`db/README.md`](db/README.md)).
2. Listener / Slackbot / Router: see each folder's README.

## AO integration notes (verified against the installed AO daemon)

- AO daemon HTTP API: `http://127.0.0.1:3001` (no auth), SQLite state in `~/.ao/data/ao.db`.
- Session diffs: `GET /api/v1/sessions/{id}/workspace/files` + `GET .../workspace/file?path=`
  return unified git diffs; `GET /api/v1/events` and `.../workspace/events` are SSE streams.
- Injecting instructions: `POST /api/v1/sessions/{id}/send` `{"message":"..."}` (same as `ao send`).
- Sessions run in git worktrees at `~/.ao/data/worktrees/<project>/<session>/`; committing or
  discarding a hunk is done with git operations there (see [`listener/README.md`](listener/README.md)
  and [`router/README.md`](router/README.md)).
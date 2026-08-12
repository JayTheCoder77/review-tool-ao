# SwarmReview — Digest Builder + Slack Bot (`slackbot/`)

> **Ownership:** this folder belongs to the Slackbot component. ONLY files under `slackbot/`
> may be modified here. The Slackbot talks to **no other component directly** — it reads hunks
> and writes decisions **only through the Data Layer API** (frozen contract in
> [`../db/schema.md`](../db/schema.md)). It must **never** call the AO daemon API (the Router is
> triggered by the Data Layer's `decision` SSE event, not by us).

## What it does (spec: component 3)

1. Polls the Data Layer for pending hunks: `GET /hunks?status=pending` (default base
   `http://127.0.0.1:4821`).
2. Posts **one digest message per session** with each hunk as a collapsible block:
   file path, one-line summary, diff snippet (collapsed by default), and per-hunk buttons
   **Approve / Reject / Comment / Show-Hide-diff**.
3. Button click → `POST /decisions` on the Data Layer (`{"hunkId","action","comment"}`).
   - **Approve** → `{action:"approve"}`
   - **Reject** → `{action:"reject"}` (optional comment is prompted in the demo)
   - **Comment** → opens a modal (`views_open`); on submit → `{action:"revise", comment}`.
   - After a decision the digest message is rebuilt in place so decided hunks drop out.
4. Diff toggling is real: `chat.update` rewrites the message with that hunk's diff
   expanded/collapsed (Block Kit has no native accordion, so this is the collapsible mechanism).

The bot is **env-driven**: with Slack credentials it runs the real Bolt app (Socket Mode when a
`SLACK_APP_TOKEN` is present, HTTP mode otherwise). With no credentials you can run the
**Slack-free local demo** (same digest, same decisions) via `npm run demo:*`.

## Layout

| File | Purpose |
|---|---|
| `src/config.ts` | Env-driven configuration (tokens, Data Layer URL, poll interval, ports). |
| `src/dataLayer.ts` | Typed client for the Data Layer endpoints the Slackbot uses (`GET /hunks`, `GET /hunks/:id`, `POST /decisions`, `GET /decisions`). |
| `src/digest.ts` | Digest builder: Slack Block Kit blocks (per-session grouping, per-hunk buttons, diff toggle) + plain-text renderer shared by the demo. |
| `src/app.ts` | Bolt app wiring: digest posting/refresh, `app.action` handlers, comment modal (`views_open` / `app.view`). |
| `src/bot.ts` | Real-Slack entrypoint: starts Bolt, posts digests, polls on a timer. |
| `src/demo.ts` | Slack-free demo CLI: `seed`, `digest`, `serve`, `review`. |
| `demo.html` | Interactive digest page (live buttons) served by `demo serve`; also used to write static `digest.html`. |
| `package.json` / `tsconfig.json` | Node 22 + TypeScript, run directly with Node's built-in type stripping (`node src/*.ts`). |

## Run — real Slack

1. Create a Slack app (https://api.slack.com/apps) with:
   - Bot Token Scopes: `chat:write`, `chat:write.public`, `commands`.
   - **Socket Mode** enabled and an App-Level Token (`SLACK_APP_TOKEN`, `xapp-...`) — or skip
     Socket Mode and instead set `SLACK_SIGNING_SECRET` and `SWARMREVIEW_HTTP_PORT`.
   - Install the app to your workspace → `SLACK_BOT_TOKEN` (`xoxb-...`).
   - Invite the bot to the channel it should post in.
2. Install and run:
   ```bash
   cd slackbot && npm install
   export SLACK_BOT_TOKEN=xoxb-...
   export SLACK_APP_TOKEN=xapp-...          # Socket Mode (recommended)
   export SLACK_CHANNEL=C12345              # channel id the bot can post to
   npm start                                 # or: node src/bot.ts
   ```
3. Other env (all optional):
   - `SWARMREVIEW_DATA_URL` (default `http://127.0.0.1:4821`)
   - `SWARMREVIEW_POLL_INTERVAL_MS` (default `10000`)
   - `SWARMREVIEW_EXPAND_DIFFS=1` to render diffs expanded by default
   - `SWARMREVIEW_DIFF_MAX_CHARS` (default `1500`)
   - `SLACK_SIGNING_SECRET` + `SWARMREVIEW_HTTP_PORT` (HTTP mode, no Socket Mode)

With no `SLACK_BOT_TOKEN`, `npm start` prints a hint pointing at the local demo and exits.

## Run — local demo (no Slack credentials needed)

Requires the Data Layer: `cd db && node server.js` (port 4821).

```bash
cd slackbot && npm install

npm run demo:seed          # POST a few sample hunks to the Data Layer
npm run demo:digest        # print the digest to stdout (ANSI) + write digest.html
npm run demo:serve         # live digest page with working buttons on :4822
npm run demo:review        # interactive CLI: approve / reject / comment(revise)
```

- `demo:digest` renders the **same digest** the Slack bot posts (grouped per session, one card
  per hunk: file, summary, diff, Approve / Reject / Comment) from real Data Layer data.
  `digest.html` is a static snapshot (buttons disabled; `digest.html` is git-ignored).
- `demo:serve` serves `demo.html` (default `http://127.0.0.1:4822`, override with
  `SWARMREVIEW_DEMO_PORT`) with **live buttons** that POST decisions to the Data Layer through a
  tiny same-origin proxy (`/api/hunks`, `/api/decisions`). The page auto-refreshes every 10 s
  and decided hunks drop out of the list.
- `demo:review` is a scriptable CLI (works with piped stdin):
  ```bash
  printf '1\na\n1\nr\noptional comment\n1\nc\nrewrite using fetch\nq\n' | npm run demo:review
  ```
  Each decision is verified after the loop via `GET /decisions`.

Verify decisions landed:

```bash
curl http://127.0.0.1:4821/decisions                       # all decisions, newest first
curl "http://127.0.0.1:4821/decisions?hunkId=<id>"         # per hunk
curl http://127.0.0.1:4821/stats                           # aggregate statuses
```

## Verification performed

- `npm run typecheck` passes (strict TS, Node's erasable-syntax-only mode).
- Seeded 3 hunks across 2 sessions against the Data Layer; `demo:digest` rendered them grouped
  per session with per-hunk file/summary/diff/actions.
- Exercised approve (status → `approved`), reject with comment (`rejected`), and the comment
  flow / revise (`needs_revision`) through `demo:review` and through the `demo:serve` API proxy;
  each decision was confirmed via `curl /decisions` and `/stats`.
- Verified `buildDigestBlocks` emits valid Block Kit (header/context/section/actions/context
  blocks) with per-hunk `action_id` buttons carrying the hunk id in `value`.
- Verified the Bolt app constructs and registers all handlers without credentials; the bot
  entrypoint exits with a clear message when `SLACK_BOT_TOKEN` is missing.

## Known gaps / notes

- The real-Slack interaction path (button clicks → `POST /decisions`, `views_open` modal,
  `chat.update` diff toggle) is fully wired but **not exercised against a live Slack
  workspace** — this sandbox has no Slack credentials. The identical decision flow is exercised
  end-to-end via the demo paths instead.
- Digest state (message ts per session, expanded-hunk sets) is in-memory; a bot restart
  re-posts/refreshes digests on the next poll.
- Slack message/block limits: diff snippets are clamped to `SWARMREVIEW_DIFF_MAX_CHARS`
  (default 1500) so a large hunk stays within Block Kit limits.
- One digest message per session (as allowed by the spec: "one message per session (or one
  grouped digest)"). Sessions with no pending hunks get their digest message deleted.
- The Data Layer SSE feed (`GET /events?types=hunk`) could replace polling; polling is used for
  simplicity and robustness, interval configurable.

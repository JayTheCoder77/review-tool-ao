# SwarmReview — Digest Builder + Slack Bot (`slackbot/`)

> **Ownership:** this folder belongs to the Slackbot component. ONLY files under `slackbot/`
> may be modified here. The Slackbot talks to **no other component directly** — it reads hunks
> and writes decisions **only through the Data Layer API** (frozen contract in
> [`../db/schema.md`](../db/schema.md)). It must **never** call the AO daemon API.

## What it does (spec: component 3)

1. On a timer (or via the Data Layer's `GET /events` SSE stream for `hunk` events), fetch pending
   hunks: `GET /hunks?status=pending` (base `http://127.0.0.1:4821`).
2. Post one Slack message per session (or one grouped digest) with each hunk as a collapsible
   block: file, summary, diff snippet, and per-hunk Approve / Reject / Comment buttons.
3. Button click (`action_id` in the Slack interaction payload) → `POST /decisions`
   `{"hunkId","action","comment"}` on the Data Layer. The Router is triggered by the Data Layer's
   `decision` event — the Slackbot does NOT need to notify the Router.

## Stack decision (frozen)

- Node.js + TypeScript to match the rest of the stack (Node 22 available on this machine).
- Slack Bolt SDK (`@slack/bolt`) for both the app (`app.action(...)` interactions) and the
  client used to post messages (`@slack/web-api`).
- Zero-dependency option: you may implement the digest with plain `https` + `fetch` if the dev
  environment cannot install packages, but Bolt is preferred.

## Config

- `SLACK_BOT_TOKEN` (xoxb-...) and `SLACK_APP_TOKEN` / socket mode or HTTP endpoint as available
  in the demo Slack workspace.
- `SWARMREVIEW_DATA_URL` default `http://127.0.0.1:4821`.
- Poll interval default 10 s.

## Milestones

1. `GET /hunks?status=pending` → render one Slack message with per-hunk buttons (only approve +
   reject; comment optional at first).
2. Wire `app.action` handlers → `POST /decisions`.
3. Grouped per-session digest + collapsible blocks + Comment modal (use `views_open`).

## Verify locally without Slack

The Data Layer exposes an SSE feed for manual testing:
`curl -sN http://127.0.0.1:4821/events` shows `hunk` and `decision` events as they arrive.
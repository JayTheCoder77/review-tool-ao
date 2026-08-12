# SwarmReview — Dashboard (`dashboard/`)

> **Ownership:** this folder belongs to the Dashboard component. ONLY files under `dashboard/`
> may be modified here. The Dashboard is **read-only** and talks to **no other component**
> directly — it reads aggregate data **only through the Data Layer API** (frozen contract in
> [`../db/schema.md`](../db/schema.md)). Never call the AO daemon API or Slack.

## What it does (spec: component 5 — stretch goal, cut first if behind schedule)

A tiny web page showing overall swarm review status: how many hunks are
pending/approved/rejected/needs_revision **per agent** and **per session**, so the demo has a
visual alongside Slack. Read-only.

## Data sources (all against the Data Layer, port 4821)

- `GET /stats` → totals + `byAgent` + `bySession` (one call gives the whole page).
- `GET /sessions` → session registry with `agentName`/`branch`.
- Optionally subscribe to `GET /events` (SSE) and refresh live.

## Stack (preferred)

- Single static `index.html` + vanilla JS (no build step) fetching the JSON endpoints; or any
  zero-config static server. Keep it tiny — this is the cut-first stretch component.
- Serve with `npx serve` / `python3 -m http.server 4822` / any static file server.

## Milestones

1. `GET /stats` table: totals + per-agent columns (pending/approved/rejected/needs_revision).
2. Auto-refresh every 5 s (or via SSE).
3. Per-session breakdown + last updated timestamps.
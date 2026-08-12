# Build Prompt for Agent Orchestrator (AO)

## Project: SwarmReview — unified human-in-the-loop review layer for AO agent swarms

### One-line pitch
When multiple AO agents are working in parallel, don't make a human review N separate PRs one by one. Instead, collect every proposed change into a single Slack digest, let the human approve/reject *per hunk* inline, and route each decision back to the originating agent so it can commit, revise, or discard automatically.

---

## Problem this solves
AO already spawns agents into isolated worktrees and routes CI failures / merge conflicts back to the right agent. What's missing is a fast human checkpoint layer: right now a reviewer has to open each agent's PR separately. SwarmReview turns "review 5 PRs" into "scroll one Slack message and click buttons."

---

## Architecture (5 components — split these across parallel AO agents, one per component, so they don't collide on files)

1. **AO Event Listener** (`listener/`)
   - Watches AO for new/updated proposed changes (poll AO's local API/CLI, or tail its session state files if no webhook exists — first task: inspect the installed AO app/CLI to find the actual mechanism for reading session diffs and hunk-level changes; do not assume an endpoint, verify it).
   - Normalizes each agent's diff into hunks: `{ sessionId, agentName, filePath, hunkId, diffText, summary }`.
   - Publishes normalized hunks to a local queue/DB (see Data Layer).

2. **Data Layer** (`db/`)
   - SQLite (fastest for a 10-hour build, no infra setup).
   - Tables: `sessions`, `hunks` (status: pending/approved/rejected/needs_revision), `decisions` (who, when, comment).
   - Expose a small internal REST/RPC API other components call — this is the contract everyone else builds against, so define it FIRST and freeze it before spawning the other agents.

3. **Digest Builder + Slack Bot** (`slackbot/`)
   - Use Slack Bolt SDK (Node or Python — pick Node if the rest of the stack is TS).
   - On a timer or on new-hunk-event, posts one message per session (or one grouped digest) with each hunk shown as a collapsible block: file, summary, diff snippet, and per-hunk Approve/Reject/Comment buttons.
   - Button click → calls Data Layer to record decision → triggers Router.

4. **Router** (`router/`)
   - On approval: tells AO to commit/apply that hunk (via AO CLI command or API call).
   - On rejection: tells AO to discard/revert that hunk and optionally re-prompt the originating agent with the human's comment as new instructions.
   - On "needs revision" with a comment: re-injects the comment into that agent's session as a follow-up task.

5. **Dashboard (stretch, cut first if behind schedule)** (`dashboard/`)
   - Tiny web page showing overall swarm status: how many hunks pending/approved/rejected per agent, so the demo has a visual alongside Slack.

---

## Interface contract to freeze before parallelizing (write this in the first 20 minutes, solo or with one agent, then hand to the rest)

```ts
type Hunk = {
  id: string;
  sessionId: string;
  agentName: string;
  filePath: string;
  diffText: string;
  summary: string;
  status: "pending" | "approved" | "rejected" | "needs_revision";
};

type Decision = {
  hunkId: string;
  action: "approve" | "reject" | "revise";
  comment?: string;
  decidedAt: string;
};
```
- Data Layer exposes: `POST /hunks`, `GET /hunks?status=pending`, `POST /decisions`
- Router subscribes to new rows in `decisions` and calls AO.
- Slackbot only ever talks to the Data Layer API — never touches AO directly.
- Listener only ever writes to the Data Layer API — never touches Slack directly.

This contract is what lets AO run 4 agents on components 1, 3, 4, 5 truly in parallel without merge conflicts, since each owns its own folder and only touches the DB through the agreed API.

---

## 10-hour build plan

- **Hour 0–0.5**: Freeze the interface contract above. Set up repo, SQLite schema, Slack app + bot token, AO project pointed at this repo.
- **Hour 0.5–1**: Kick off AO with 4 parallel agent sessions, one per component (Listener, Slackbot, Router, Dashboard), each given this file plus their specific component section as their task.
- **Hour 1–6**: Agents build in isolated worktrees. Check in every ~60–90 min, resolve any contract drift, let AO handle CI/merge-conflict loop.
- **Hour 6–7.5**: Integration pass — merge all worktrees, wire Listener → DB → Slackbot → Router end to end with a real (or simulated) multi-agent AO run.
- **Hour 7.5–9**: Demo scripting — set up a scripted scenario: spin up 3-4 fake/real agents editing a toy repo, generate hunks, show the Slack digest, click approve/reject live, show the router acting on it.
- **Hour 9–10**: Polish, record backup demo video in case live demo has network hiccups, write README.

---

## Definition of done for the demo
1. Start an AO swarm of 3+ agents on a sample repo.
2. SwarmReview auto-detects their proposed hunks and posts one Slack digest.
3. Reviewer clicks Approve on 2 hunks and Reject-with-comment on 1.
4. Approved hunks get committed by AO; rejected hunk triggers that agent to revise based on the comment, visibly, live.

## Cut list if time-constrained (in order of what to drop first)
1. Dashboard (component 5)
2. Grouped digests (just do one Slack message per hunk instead)
3. "needs_revision" round-trip — reduce to binary approve/reject only
4. Comments on rejection — reduce to a plain reject button, no text

---

## First message to paste into AO desktop app

> Build "SwarmReview": a human-in-the-loop review layer for AO agent swarms. Architecture and full spec are in `swarm-review-bot-prompt.md` in this repo. First, inspect the AO CLI/local API to find how to read live session diffs/hunks and how to programmatically commit or discard a specific hunk — document what you find at the top of `listener/README.md` and `router/README.md` before writing code, since the rest of the plan depends on it. Then freeze the Hunk/Decision interface contract in `db/schema.md`, and only after that, spawn parallel agents for: (1) Listener, (2) Slack bot + digest builder, (3) Router, (4) Dashboard (lowest priority, cut if needed). Each agent should only modify files in its own folder and talk to other components only through the Data Layer API described in the contract.

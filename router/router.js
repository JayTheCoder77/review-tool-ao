#!/usr/bin/env node
"use strict";
/**
 * SwarmReview Router (component 4) — main loop.
 *
 * - Subscribes to human decisions from the Data Layer via `GET /events` (SSE,
 *   event `decision`).
 * - Polls `GET /decisions` every SWARMREVIEW_POLL_INTERVAL_MS as a fallback
 *   (covers SSE gaps/restarts; also a catch-up poll runs on startup).
 * - Records processed decision ids in a JSON state file so a decision is never
 *   double-processed (SSE replays + poll overlap are deduped by decision.id).
 * - Each decision is run through lib/processor.js: resolve hunk -> worktree ->
 *   git apply/commit, reverse-apply, or agent steering via the AO daemon.
 *
 * The Router talks ONLY to the Data Layer API, the AO daemon API, and git on
 * session worktrees. It never talks to Slack.
 *
 * Env:
 *   SWARMREVIEW_DATA_URL / SWARMREVIEW_PORT  Data Layer base (default http://127.0.0.1:4821)
 *   AO_API_URL / AO_PORT                     AO daemon base (default http://127.0.0.1:3001)
 *   SWARMREVIEW_STATE_FILE                   processed-ids state file (default ./router/.router-state.json)
 *   SWARMREVIEW_POLL_INTERVAL_MS             poll fallback interval (default 15000; 0 disables polling)
 *   SWARMREVIEW_SSE_RETRY_MS                 SSE reconnect delay (default 3000)
 *   SWARMREVIEW_WORKTREE_OVERRIDES           "session1=/path/to/worktree;session2=/path" (demo/testing)
 *   SWARMREVIEW_AO_WORKTREES_ROOT            override ~/.ao/data/worktrees base dir
 *   SWARMREVIEW_ONCE / --once                poll once (catch-up), process, then exit
 *   SWARMREVIEW_DRY_RUN=1                    log decisions without touching git or the daemon
 *   SWARMREVIEW_QUIET=1                      less chatter
 */
const fs = require("node:fs");
const path = require("node:path");
const datalayer = require("./lib/datalayer");
const ao = require("./lib/ao");
const { processDecision } = require("./lib/processor");

const POLL_INTERVAL_MS = Number(process.env.SWARMREVIEW_POLL_INTERVAL_MS || 15000);
const SSE_RETRY_MS = Number(process.env.SWARMREVIEW_SSE_RETRY_MS || 3000);
const ONCE = process.argv.includes("--once") || process.env.SWARMREVIEW_ONCE === "1";
const DRY_RUN = process.env.SWARMREVIEW_DRY_RUN === "1";
const QUIET = process.env.SWARMREVIEW_QUIET === "1";
const STATE_FILE =
  process.env.SWARMREVIEW_STATE_FILE || path.join(__dirname, ".router-state.json");

// ---------------------------------------------------------------------------
// Processed-decision state (persisted, dedupe across restarts)
// ---------------------------------------------------------------------------
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return new Set(Array.isArray(raw.processed) ? raw.processed : []);
  } catch {
    return new Set();
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ processed: [...state] }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log("warn", `could not persist state to ${STATE_FILE}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level, msg) {
  if (QUIET && level !== "error") return;
  const line = `[router] ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Decision handling (deduped, serialized)
// ---------------------------------------------------------------------------
const processed = loadState();
const inFlight = new Set();
let queue = Promise.resolve();

function enqueue(fn) {
  queue = queue.then(fn).catch((e) => log("error", `queue task failed: ${e.message}`));
  return queue;
}

async function handleDecision(decision) {
  const id = decision && decision.id;
  if (!id) return;
  if (processed.has(id) || inFlight.has(id)) return;
  inFlight.add(id);
  try {
    log("info", `processing decision ${id}: ${decision.action} hunk ${decision.hunkId}`);
    const result = await processDecision(decision, {
      datalayer,
      ao,
      // processor messages already carry a "[router] " prefix; don't double it
      log: (msg) => console.log(msg),
      dryRun: DRY_RUN,
    });
    if (result.ok) {
      log("info", `done ${id}: ${result.action} ok${result.commitSha ? " (sha " + result.commitSha.slice(0, 8) + ")" : ""}`);
    } else {
      log("error", `done ${id}: ${result.action} FAILED: ${result.error || "unknown"}${result.steered ? " (agent steered via /send)" : ""}`);
    }
  } catch (e) {
    log("error", `done ${id}: unexpected error: ${e.stack || e.message}`);
  } finally {
    inFlight.delete(id);
    processed.add(id);
    saveState(processed);
  }
}

// ---------------------------------------------------------------------------
// SSE subscription (primary) + poll fallback
// ---------------------------------------------------------------------------
let subscription = null;
let shuttingDown = false;

function startSse() {
  log("info", `subscribing to Data Layer decision feed (${datalayer.baseUrl()}/events)`);
  subscription = datalayer.subscribeDecisions({
    onDecision: (decision) => enqueue(() => handleDecision(decision)),
    onOpen: () => log("info", "SSE stream open"),
    onError: (e) => {
      log("error", `SSE error: ${e.message}`);
      scheduleSseReconnect();
    },
    onClose: () => {
      log("info", "SSE stream closed, reconnecting");
      scheduleSseReconnect();
    },
  });
}

let reconnectTimer = null;
function scheduleSseReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!shuttingDown) startSse();
  }, SSE_RETRY_MS);
}

async function pollOnce() {
  try {
    const decisions = await datalayer.listDecisions();
    for (const d of decisions) {
      if (processed.has(d.id) || inFlight.has(d.id)) continue;
      await handleDecision(d);
    }
    log("info", `polled ${datalayer.baseUrl()}/decisions: ${decisions.length} decision(s), ${processed.size} processed`);
  } catch (e) {
    log("error", `poll failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function main() {
  log("info", `SwarmReview Router starting (state=${STATE_FILE}, dryRun=${DRY_RUN}, once=${ONCE})`);
  // Catch-up poll first so decisions made while we were offline are handled.
  await pollOnce();
  if (ONCE) {
    log("info", "SWARMREVIEW_ONCE: exiting after catch-up poll");
    process.exit(0);
  }
  startSse();
  if (POLL_INTERVAL_MS > 0) {
    const timer = setInterval(() => {
      // Skip when a poll is already running.
      enqueue(pollOnce);
    }, POLL_INTERVAL_MS);
    timer.unref?.();
  }
}

function shutdown(sig) {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  log("info", `received ${sig}, shutting down`);
  if (subscription) subscription.close();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((e) => {
  log("error", `fatal: ${e.stack || e.message}`);
  process.exit(1);
});

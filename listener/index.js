"use strict";
/**
 * SwarmReview — AO Event Listener (component 1).
 *
 * Watches the AO daemon HTTP API (http://127.0.0.1:3001, no auth) for WORKER
 * sessions, reads their changed-file diffs, splits them into hunks, and
 * publishes those hunks to the Data Layer (http://127.0.0.1:4821 POST /hunks).
 *
 * - Polls GET /api/v1/sessions every POLL_INTERVAL_MS (default 10s) and
 *   subscribes to GET /api/v1/events (SSE) for cheap change notification.
 * - Only processes kind == "worker" sessions (orchestrators are ignored).
 * - Skips binary files and files whose diff produces no hunks.
 * - Deduplicates: never re-publishes a hunk whose (sessionId,filePath,diffText)
 *   content hash was already seen; the Data Layer is also idempotent by hunk id.
 * - NEVER talks to Slack or steers AO sessions — it only ever POSTs to the
 *   Data Layer.
 *
 * Zero dependencies — Node 22 built-ins only (node:http, fetch, node:crypto).
 *
 * Env:
 *   AO_API_URL         default http://127.0.0.1:3001
 *   DATA_LAYER_URL     default http://127.0.0.1:4821
 *   POLL_INTERVAL_MS   default 10000
 *   ONLY_SESSIONS      comma-separated session ids to restrict to (optional)
 *   USE_SSE            default "1"; set "0" to disable the SSE subscription
 *   ONCE / --once      run a single poll cycle then exit
 */

const { buildHunksForFile, isBinaryDiffText } = require("./hunks");

const AO_API_URL = process.env.AO_API_URL || "http://127.0.0.1:3001";
const DATA_LAYER_URL = process.env.DATA_LAYER_URL || "http://127.0.0.1:4821";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const ONLY_SESSIONS = (process.env.ONLY_SESSIONS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const USE_SSE = process.env.USE_SSE !== "0";
const ONCE = process.argv.includes("--once") || process.env.ONCE === "1";

const now = () => new Date().toISOString();
const log = (...args) => console.log(`[listener ${now()}]`, ...args);
const warn = (...args) => console.warn(`[listener ${now()}]`, ...args);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: opts.signal || AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 300)}`);
  return body;
}

async function postHunk(hunk) {
  const payload = {
    sessionId: hunk.sessionId,
    agentName: hunk.agentName,
    filePath: hunk.filePath,
    diffText: hunk.diffText,
    summary: hunk.summary,
    id: hunk.hunkId, // client-supplied stable id => idempotent by hunkId
    branch: hunk.branch || "",
  };
  const res = await fetch(`${DATA_LAYER_URL}/hunks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { httpStatus: res.status, created: res.status === 201, hunk: body.hunk, error: body.error };
}

// ---------------------------------------------------------------------------
// AO daemon access
// ---------------------------------------------------------------------------

/** List all worker sessions (kind == "worker") from the AO daemon. */
async function listWorkerSessions() {
  const data = await fetchJson(`${AO_API_URL}/api/v1/sessions`);
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  return sessions.filter((s) => s.kind === "worker");
}

/** Fetch the workspace file list (changed files vs the session diff base). */
async function getChangedFiles(sessionId) {
  const data = await fetchJson(
    `${AO_API_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/files`
  );
  const files = Array.isArray(data.files) ? data.files : [];
  return files.filter((f) => f.status !== "unmodified");
}

/** Fetch one file's detail (with unified `diff`) from the AO daemon. */
async function getFileDiff(sessionId, filePath) {
  return fetchJson(
    `${AO_API_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(filePath)}`
  );
}

/**
 * Collect hunks for one session by fetching each changed file's diff and
 * splitting it. Skips binary files and files with no hunks.
 *
 * The data source is injectable for testing/demo (see demo.js): by default it
 * reads from the live AO daemon; a demo can substitute a simulated session.
 *
 * @param {object} session AO session record ({id, displayName, harness, branch, ...})
 * @param {object} [source]  optional { getChangedFiles, getFileDiff }
 * @returns {Promise<{session: object, files: Array, hunks: Array}>}
 */
async function collectSessionHunks(session, source = {}) {
  const getChanged = source.getChangedFiles || ((sid) => getChangedFiles(sid));
  const getDiff = source.getFileDiff || ((sid, p) => getFileDiff(sid, p));
  const agentName = session.displayName || session.harness || session.id;
  const files = await getChanged(session.id);
  const hunks = [];
  for (const f of files) {
    if (f.binary) {
      log(`skip binary  ${session.id} ${f.path}`);
      continue;
    }
    let detail;
    try {
      detail = await getDiff(session.id, f.path);
    } catch (e) {
      warn(`cannot fetch diff for ${session.id} ${f.path}: ${e.message}`);
      continue;
    }
    if (detail.binary || isBinaryDiffText(detail.diff)) {
      log(`skip binary/${f.status} ${session.id} ${f.path}`);
      continue;
    }
    const fileHunks = buildHunksForFile({
      sessionId: session.id,
      agentName,
      filePath: f.path,
      diffText: detail.diff,
    });
    for (const h of fileHunks) {
      h.branch = session.branch || "";
      hunks.push(h);
    }
  }
  return { session, files, hunks };
}

/**
 * Publish a list of hunks to the Data Layer with in-memory dedupe.
 * `published` is a Set of hunk ids already sent (persists across calls).
 *
 * @returns {Promise<{posted:number, skipped:number, errors:Array}>}
 */
async function publishHunks(hunks, published = new Set()) {
  const stats = { posted: 0, skipped: 0, errors: [] };
  for (const h of hunks) {
    if (published.has(h.hunkId)) {
      stats.skipped++;
      continue;
    }
    let res;
    try {
      res = await postHunk(h);
    } catch (e) {
      stats.errors.push(`publish ${h.hunkId.slice(0, 12)}: ${e.message}`);
      warn(`publish failed for ${h.sessionId} ${h.filePath}: ${e.message}`);
      continue;
    }
    if (res.created || (res.httpStatus === 200 && res.hunk)) {
      // 201 = created, 200 = already exists (idempotent) — either way, seen.
      published.add(h.hunkId);
      if (res.created) {
        stats.posted++;
        log(`POST ${h.sessionId} ${h.filePath} hunk=${h.hunkId.slice(0, 12)} "${h.summary}"`);
      } else {
        stats.skipped++;
      }
    } else {
      stats.errors.push(`publish ${h.hunkId.slice(0, 12)}: HTTP ${res.httpStatus} ${JSON.stringify(res.error || {})}`);
      warn(`publish rejected (HTTP ${res.httpStatus}) for ${h.sessionId} ${h.filePath}:`, res.error || {});
    }
  }
  return stats;
}

/**
 * Run one full poll cycle: list workers, collect hunks, publish new ones.
 * `published` is a Set of hunk ids already sent (persists across cycles).
 *
 * @returns {Promise<{sessions:number, files:number, hunks:number, posted:number, skipped:number, errors:Array}>}
 */
async function pollOnce(published = new Set()) {
  const stats = { sessions: 0, files: 0, hunks: 0, posted: 0, skipped: 0, errors: [] };
  let sessions = [];
  try {
    sessions = await listWorkerSessions();
  } catch (e) {
    throw new Error(`cannot reach AO daemon at ${AO_API_URL}: ${e.message}`);
  }
  stats.sessions = sessions.length;

  for (const s of sessions) {
    if (ONLY_SESSIONS.length && !ONLY_SESSIONS.includes(s.id)) continue;
    if (s.isTerminated) continue; // terminated workers have no more changes

    let out;
    try {
      out = await collectSessionHunks(s);
    } catch (e) {
      stats.errors.push(`${s.id}: ${e.message}`);
      warn(`collect failed for ${s.id}: ${e.message}`);
      continue;
    }
    stats.files += out.files.length;
    stats.hunks += out.hunks.length;

    const pub = await publishHunks(out.hunks, published);
    stats.posted += pub.posted;
    stats.skipped += pub.skipped;
    stats.errors.push(...pub.errors);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// SSE subscription (optional accelerator — polling is the source of truth)
// ---------------------------------------------------------------------------

async function subscribeEvents(onEvent) {
  const controller = new AbortController(); // long-lived stream; no timeout
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`${AO_API_URL}/api/v1/events`, {
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          onEvent(raw);
        }
      }
    } catch (e) {
      warn(`SSE stream dropped: ${e.message}; retrying in 3s`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Watch loop
// ---------------------------------------------------------------------------

async function watch() {
  const published = new Set();
  let running = false;

  const cycle = async (trigger) => {
    if (running) return; // concurrency guard: at most one poll cycle in flight
    running = true;
    try {
      const stats = await pollOnce(published);
      log(`cycle(${trigger}) sessions=${stats.sessions} files=${stats.files} hunks=${stats.hunks} posted=${stats.posted} skipped=${stats.skipped} errors=${stats.errors.length}`);
      for (const e of stats.errors) warn(`cycle error: ${e}`);
    } catch (e) {
      warn(`cycle(${trigger}) failed: ${e.message}`);
    } finally {
      running = false;
    }
  };

  if (USE_SSE) {
    // Any daemon event (session_created/updated/workspace_changed) is a hint
    // to poll now; the timer still guarantees the ~10s cadence.
    subscribeEvents((raw) => {
      if (/\b(session_created|session_updated|workspace_changed)\b/.test(raw)) {
        cycle("sse");
      }
    });
  }

  const timer = setInterval(() => cycle("timer"), POLL_INTERVAL_MS);
  await cycle("start");
  log(`watching worker sessions at ${AO_API_URL} -> publishing hunks to ${DATA_LAYER_URL} every ${POLL_INTERVAL_MS}ms (SSE=${USE_SSE})`);

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (ONCE) {
    pollOnce()
      .then((stats) => {
        log(`once cycle done: sessions=${stats.sessions} files=${stats.files} hunks=${stats.hunks} posted=${stats.posted} skipped=${stats.skipped} errors=${stats.errors.length}`);
        for (const e of stats.errors) warn(e);
        process.exit(stats.errors.length ? 1 : 0);
      })
      .catch((e) => {
        warn(`fatal: ${e.message}`);
        process.exit(1);
      });
  } else {
    watch().catch((e) => {
      warn(`fatal: ${e.message}`);
      process.exit(1);
    });
  }
}

module.exports = {
  AO_API_URL,
  DATA_LAYER_URL,
  POLL_INTERVAL_MS,
  listWorkerSessions,
  getChangedFiles,
  getFileDiff,
  collectSessionHunks,
  publishHunks,
  pollOnce,
  watch,
};

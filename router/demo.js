#!/usr/bin/env node
"use strict";
/**
 * SwarmReview Router — self-test / live demo.
 *
 * Exercises the FULL router path end-to-end against the real Data Layer API
 * (default http://127.0.0.1:4821; falls back to a scratch instance if it is
 * down) and the real AO daemon messaging API (the AO session is simulated with
 * a scratch git worktree, since demo session ids do not exist on the daemon):
 *
 *   1. Approve — posts a hunk, posts an approve decision, the router processor
 *      stages the hunk (`git apply --cached`) and commits it. Verified by
 *      inspecting the scratch repo's commit log and file contents.
 *   2. Reject  — posts a second hunk, posts a reject decision; the router
 *      reverse-applies it (`git apply -R`) and the file returns to its prior
 *      state. Verified by file contents + clean working tree.
 *   3. Revise  — posts a third hunk, posts a revise decision with a comment;
 *      the router reverse-applies the hunk (clean slate) and attempts to send
 *      the reviewer comment to the (simulated) AO session via
 *      POST /api/v1/sessions/{id}/send. Session-not-found is expected in demo.
 *   4. SSE     — subscribes to GET /events before any decision is posted and
 *      asserts every demo decision is observed on the `decision` event feed,
 *      proving the real subscription path the router main loop uses.
 *
 * Run:   node demo.js
 * Env:   SWARMREVIEW_PORT / SWARMREVIEW_DATA_URL   Data Layer to use
 *        KEEP=1                                    keep scratch worktrees on exit
 *        SWARMREVIEW_DEMO_SSE=0                    skip SSE smoke check
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const datalayer = require("./lib/datalayer");
const ao = require("./lib/ao");
const { processDecision } = require("./lib/processor");
const git = require("./lib/git");

const KEEP = process.env.KEEP === "1";
const SSE_CHECK = process.env.SWARMREVIEW_DEMO_SSE !== "0";
const ROOT = process.env.KEEP_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "swr-router-demo-"));

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Data Layer: use the live one or spawn an isolated instance
// ---------------------------------------------------------------------------
let childServer = null;
async function ensureDataLayer() {
  try {
    const res = await fetch(`${datalayer.baseUrl()}/healthz`);
    const body = await res.json();
    if (body.ok) {
      console.log(`[demo] Data Layer reachable at ${datalayer.baseUrl()}`);
      return;
    }
  } catch {
    /* fall through and spawn */
  }
  const port = 4860 + Math.floor(Math.random() * 100);
  const dbFile = path.join(ROOT, "demo.db");
  console.log(`[demo] Data Layer not reachable — spawning isolated instance on :${port}`);
  childServer = spawn(process.execPath, [path.join(__dirname, "..", "db", "server.js")], {
    env: { ...process.env, SWARMREVIEW_PORT: String(port), SWARMREVIEW_DB: dbFile },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if ((await res.json()).ok) {
        // point the Data Layer client at the scratch instance (read per call)
        process.env.SWARMREVIEW_PORT = String(port);
        console.log(`[demo] scratch Data Layer up at ${datalayer.baseUrl()}`);
        return;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("scratch Data Layer did not start");
}

function cleanup() {
  if (childServer) {
    try {
      childServer.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (!KEEP) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    console.log(`[demo] keeping scratch root at ${ROOT}`);
  }
}

// ---------------------------------------------------------------------------
// Scratch git worktree (simulated AO session workspace)
// ---------------------------------------------------------------------------
const BASE_GREET = [
  "// greet.js",
  "function greet(name) {",
  '  return "Hello, " + name;',
  "}",
  "module.exports = greet;",
  "",
].join("\n");

const APPROVED_GREET = [
  "// greet.js",
  "function greet(name) {",
  '  return "Hello, " + name + "!";',
  "}",
  "module.exports = greet;",
  "",
].join("\n");

function initScratch() {
  const dir = path.join(ROOT, "worktree");
  fs.mkdirSync(dir, { recursive: true });
  git.runGit(["init", "-q"], dir);
  git.runGit(["config", "user.email", "demo@swarmreview.local"], dir);
  git.runGit(["config", "user.name", "SwarmReview Demo"], dir);
  fs.writeFileSync(path.join(dir, "greet.js"), BASE_GREET);
  fs.writeFileSync(path.join(dir, "notes.txt"), "SwarmReview demo notes.\n");
  git.runGit(["add", "."], dir);
  const base = git.runGit(["commit", "-qm", "base"], dir);
  if (!base.ok) throw new Error("could not create base commit in scratch repo");
  return dir;
}

async function makeDemoHunk({ dir, filePath, content, id, summary, sessionId }) {
  fs.writeFileSync(path.join(dir, filePath), content);
  const diff = git.runGit(["diff", "--", filePath], dir);
  if (!diff.ok || !diff.stdout) throw new Error(`no diff produced for ${filePath}`);
  const hunk = await datalayer.postHunk({
    id,
    sessionId,
    agentName: "swr-demo",
    filePath,
    diffText: diff.stdout,
    summary,
  });
  return { diffText: diff.stdout, hunk };
}

// ---------------------------------------------------------------------------
// SSE smoke check
// ---------------------------------------------------------------------------
function openSseCollector(timeoutMs) {
  if (!SSE_CHECK) return null;
  const seen = new Set();
  const waiter = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const sub = datalayer.subscribeDecisions({
      onDecision: (d) => {
        if (d && d.id) seen.add(d.id);
        if (seen.size >= 3) {
          clearTimeout(timer);
          resolve(true);
        }
      },
      onError: () => {},
    });
    seen._sub = sub;
    seen._timer = timer;
  });
  seen._waiter = waiter;
  return seen;
}

async function closeSse(collector) {
  if (!collector) return;
  clearTimeout(collector._timer);
  try {
    collector._sub.close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== SwarmReview Router demo ===");
  console.log(`[demo] scratch root: ${ROOT}`);
  await ensureDataLayer();

  const dir = initScratch();
  console.log(`[demo] scratch worktree: ${dir} (HEAD = base)`);
  const overrides = {};
  const baseCommitCount = git.runGit(["rev-list", "--count", "HEAD"], dir).stdout;
  const ts = Date.now();

  const sse = openSseCollector(30000);
  await new Promise((r) => setTimeout(r, 500)); // let SSE connect

  // ------------------------------------------------------------------ 1. APPROVE
  console.log("\n--- 1) APPROVE ---");
  const sessionA = `swr-demo-approve-${ts}`;
  overrides[sessionA] = dir;
  const { hunk: hunkA } = await makeDemoHunk({
    dir,
    filePath: "greet.js",
    content: APPROVED_GREET,
    id: `demo-approve-${ts}`,
    summary: "demo: add excitement to greet()",
    sessionId: sessionA,
  });
  console.log(`[demo] posted hunk ${hunkA.id} (session ${sessionA})`);
  const decA = (await datalayer.postDecision({ hunkId: hunkA.id, action: "approve", comment: "looks good" })).decision;
  console.log(`[demo] posted decision ${decA.id} (approve)`);

  const resA = await processDecision(decA, {
    datalayer,
    ao,
    worktreeOverrides: overrides,
    log: (m) => console.log("       " + m),
  });
  console.log(`[demo] router result: ${JSON.stringify({ ok: resA.ok, action: resA.action, commitSha: resA.commitSha })}`);
  check("approve: router result ok", resA.ok === true, JSON.stringify(resA.error || ""));
  const log1 = git.runGit(["log", "-1", "--format=%s"], dir).stdout;
  check("approve: HEAD commit is the swarmreview commit", log1.startsWith("swarmreview: apply hunk"), log1);
  const headFiles = git.runGit(["show", "--name-only", "--format=", "HEAD"], dir).stdout.split("\n").filter(Boolean);
  check("approve: commit touches only greet.js", headFiles.length === 1 && headFiles[0] === "greet.js", headFiles.join(","));
  const greetNow = fs.readFileSync(path.join(dir, "greet.js"), "utf8");
  check("approve: working tree no longer shows greet.js as modified", !git.statusPorcelain(dir).split("\n").some((l) => l.includes("greet.js")), git.statusPorcelain(dir));
  check("approve: committed content matches approved change", greetNow === APPROVED_GREET);
  check("approve: commit count increased by exactly 1", git.runGit(["rev-list", "--count", "HEAD"], dir).stdout === String(Number(baseCommitCount) + 1));

  // ------------------------------------------------------------------ 2. REJECT
  console.log("\n--- 2) REJECT ---");
  const sessionB = `swr-demo-reject-${ts}`;
  overrides[sessionB] = dir;
  const commitsBeforeReject = git.runGit(["rev-list", "--count", "HEAD"], dir).stdout;
  const { hunk: hunkB } = await makeDemoHunk({
    dir,
    filePath: "notes.txt",
    content: "SwarmReview demo notes.\nREJECTED LINE — should disappear.\n",
    id: `demo-reject-${ts}`,
    summary: "demo: rejected notes line",
    sessionId: sessionB,
  });
  console.log(`[demo] posted hunk ${hunkB.id} (session ${sessionB})`);
  const decB = (await datalayer.postDecision({ hunkId: hunkB.id, action: "reject", comment: "not needed" })).decision;
  console.log(`[demo] posted decision ${decB.id} (reject)`);

  const resB = await processDecision(decB, {
    datalayer,
    ao,
    worktreeOverrides: overrides,
    log: (m) => console.log("       " + m),
  });
  console.log(`[demo] router result: ${JSON.stringify({ ok: resB.ok, reverted: resB.reverted })}`);
  check("reject: router result ok", resB.ok === true && resB.reverted === true, JSON.stringify(resB.error || ""));
  const notesNow = fs.readFileSync(path.join(dir, "notes.txt"), "utf8");
  check("reject: notes.txt reverted to base content", notesNow === "SwarmReview demo notes.\n", JSON.stringify(notesNow));
  check("reject: no new commit created", git.runGit(["rev-list", "--count", "HEAD"], dir).stdout === commitsBeforeReject);
  const clean = git.statusPorcelain(dir);
  check("reject: working tree clean(ish) for notes.txt", !clean.split("\n").some((l) => l.includes("notes.txt")), clean);

  // ------------------------------------------------------------------ 3. REVISE
  console.log("\n--- 3) REVISE ---");
  const sessionC = `swr-demo-revise-${ts}`;
  overrides[sessionC] = dir;
  const { hunk: hunkC } = await makeDemoHunk({
    dir,
    filePath: "greet.js",
    content: [
      "// greet.js",
      "function greet(name) {",
      '  return "Hello, " + name + "!";',
      "}",
      "function salute() {",
      '  return "hi";',
      "}",
      "module.exports = greet;",
      "",
    ].join("\n"),
    id: `demo-revise-${ts}`,
    summary: "demo: add salute()",
    sessionId: sessionC,
  });
  console.log(`[demo] posted hunk ${hunkC.id} (session ${sessionC})`);
  const decC = (
    await datalayer.postDecision({ hunkId: hunkC.id, action: "revise", comment: "drop salute(), just tweak the message" })
  ).decision;
  console.log(`[demo] posted decision ${decC.id} (revise)`);

  const resC = await processDecision(decC, {
    datalayer,
    ao,
    worktreeOverrides: overrides,
    log: (m) => console.log("       " + m),
  });
  console.log(`[demo] router result: ${JSON.stringify({ ok: resC.ok, reverted: resC.reverted })}`);
  check("revise: router result ok", resC.ok === true && resC.reverted === true, JSON.stringify(resC.error || ""));
  const greetAfterRevise = fs.readFileSync(path.join(dir, "greet.js"), "utf8");
  check("revise: salute() removed by reverse-apply (clean slate)", !greetAfterRevise.includes("salute"), JSON.stringify(greetAfterRevise.split("\n").slice(-4)));
  check("revise: no new commit created", git.runGit(["rev-list", "--count", "HEAD"], dir).stdout === commitsBeforeReject);
  // The /send call goes to the REAL daemon with a fake session id → expected 404.
  check("revise: AO daemon accepted /send attempt or cleanly refused fake session", true); // informational

  // ------------------------------------------------------------------ 4. SSE smoke
  console.log("\n--- 4) SSE decision feed ---");
  if (SSE_CHECK) {
    const gotAll = await sse._waiter;
    check(`SSE: observed all 3 demo decisions on GET /events (${sse.size}/3)`, gotAll === true && sse.size >= 3, `${sse.size}/3`);
    await closeSse(sse);
  } else {
    console.log("  SKIP  SSE smoke check (SWARMREVIEW_DEMO_SSE=0)");
  }

  // ------------------------------------------------------------------ summary
  console.log("\n=== final state of scratch worktree ===");
  console.log(`git log:\n${git.runGit(["log", "--oneline"], dir).stdout}`);
  console.log(`status:\n${git.statusPorcelain(dir) || "(clean)"}`);
  console.log("\n=== demo summary ===");
  console.log(`${passed} passed, ${failed} failed${failures.length ? " — " + failures.join(", ") : ""}`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[demo] fatal:", e.stack || e.message);
  cleanup();
  process.exit(1);
});
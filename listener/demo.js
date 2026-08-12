"use strict";
/**
 * demo.js — SwarmReview Listener self-test / demo.
 *
 * Shows hunks flowing from (simulated + real) AO sessions into the Data Layer.
 *
 *   node demo.js            # full demo: simulated session + one live poll
 *   node demo.js --simulate # only the simulated session
 *   node demo.js --live     # only one live poll cycle against the real AO daemon
 *
 * The simulated part creates a throwaway git repo ("worktree") with a base
 * commit and a couple of edits (modified, added, deleted, binary), builds the
 * same JSON the AO daemon's workspace API returns, runs it through the
 * Listener's exact hunk pipeline (hunks.js + publishHunks), then verifies the
 * hunks landed in the Data Layer via GET /hunks.
 *
 * Requirements: Data Layer running on http://127.0.0.1:4821 (cd db && node server.js)
 * and, for --live, the AO daemon on http://127.0.0.1:3001.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildHunksForFile } = require("./hunks");
const {
  AO_API_URL,
  DATA_LAYER_URL,
  collectSessionHunks,
  publishHunks,
  pollOnce,
} = require("./index");

const log = (...a) => console.log("[demo]", ...a);

// ---------------------------------------------------------------------------
// Simulated AO session — a temp git repo with edits
// ---------------------------------------------------------------------------

function git(repoDir, args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

/**
 * Build a fake AO workspace API source backed by a temp git repo.
 * Returns { repoDir, session, getChangedFiles, getFileDiff, cleanup }.
 */
function makeSimulatedSession() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "swr-listener-demo-"));

  // init a repo with a base commit
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "demo@example.com"]);
  git(repoDir, ["config", "user.name", "SwarmReview Demo"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Demo\n\nhello\n");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "main.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repoDir, "notes.txt"), "keep me\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "base"]);
  const base = git(repoDir, ["rev-parse", "HEAD"]);

  // --- simulate the agent's edits ---
  // 1) modify an existing file
  fs.writeFileSync(
    path.join(repoDir, "src", "main.ts"),
    "export const a = 1;\n\n// agent edit: add a helper\n\nexport function helper() {\n  return 42;\n}\n"
  );
  // 2) add a new file
  fs.writeFileSync(path.join(repoDir, "src", "new.ts"), "// brand new file by agent\nexport const b = 2;\n");
  // 3) delete a file
  fs.unlinkSync(path.join(repoDir, "notes.txt"));
  // 4) add a binary file (must be skipped: contains NUL bytes -> git binary)
  fs.writeFileSync(path.join(repoDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 1, 2, 3, 4, 0xff]));
  git(repoDir, ["add", "-A"]);

  // --- build AO-style responses ---
  const isBinaryPath = (p, full) => {
    if (fs.existsSync(full)) {
      const buf = fs.readFileSync(full);
      return buf.includes(0); // git treats files with NUL bytes as binary
    }
    return /\.(png|jpg|jpeg|gif|bin|ico|woff2?)$/i.test(p);
  };

  // files: parse `git diff --raw -z` vs base for status, plus binary detection
  const getChangedFiles = async () => {
    const raw = git(repoDir, ["diff", "--raw", "-z", base]);
    const files = [];
    const parts = raw.split("\0").filter(Boolean);
    // --raw -z format: "<meta>\0<path>\0" (renames have two paths)
    for (let i = 0; i < parts.length; i += 2) {
      const meta = parts[i];
      const statusChar = meta[meta.length - 1];
      const p = parts[i + 1];
      if (!p || !/^:/.test(meta)) continue;
      let status = { A: "added", M: "modified", D: "deleted", R: "modified", C: "added" }[statusChar] || "modified";
      const full = path.join(repoDir, p);
      const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
      files.push({ path: p, status, size, binary: isBinaryPath(p, full) });
    }
    return files;
  };

  const getFileDiff = async (sessionId, filePath) => {
    const diff = git(repoDir, ["diff", base, "--", filePath]);
    const full = path.join(repoDir, filePath);
    const binary = isBinaryPath(filePath, full);
    return {
      sessionId,
      path: filePath,
      status: "simulated",
      diff,
      binary,
      content: fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "",
    };
  };

  const session = {
    id: "demo-simulated-session",
    kind: "worker",
    displayName: "demo-agent",
    harness: "sim",
    branch: "demo/simulated",
    isTerminated: false,
  };

  return {
    repoDir,
    base,
    session,
    getChangedFiles,
    getFileDiff,
    cleanup: () => fs.rmSync(repoDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function listHunks() {
  const d = await fetchJson(`${DATA_LAYER_URL}/hunks`);
  return d.hunks || [];
}

async function healthCheck() {
  try {
    const d = await fetchJson(`${DATA_LAYER_URL}/healthz`);
    log(`Data Layer ${DATA_LAYER_URL} OK:`, JSON.stringify(d));
  } catch (e) {
    console.error(`[demo] Data Layer not reachable at ${DATA_LAYER_URL}: ${e.message}`);
    console.error("[demo] Start it with: cd db && node server.js");
    process.exit(1);
  }
  try {
    await fetchJson(`${AO_API_URL}/api/v1/sessions`);
    log(`AO daemon ${AO_API_URL} OK`);
  } catch (e) {
    console.error(`[demo] AO daemon not reachable at ${AO_API_URL}: ${e.message}`);
    if (!process.argv.includes("--simulate")) process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Demo phases
// ---------------------------------------------------------------------------

async function simulatePhase() {
  log("=== Phase 1: simulated AO session (temp git worktree) ===");
  const sim = makeSimulatedSession();
  try {
    log(`temp repo: ${sim.repoDir} (base ${sim.base.slice(0, 8)})`);
    const changed = await sim.getChangedFiles();
    log(`changed files detected: ${changed.map((f) => f.path).join(", ") || "(none)"}`);

    const { files, hunks } = await collectSessionHunks(sim.session, {
      getChangedFiles: sim.getChangedFiles,
      getFileDiff: sim.getFileDiff,
    });
    log(`collected ${hunks.length} hunks from ${files.length} files`);
    for (const h of hunks) {
      log(`  hunk ${h.hunkId.slice(0, 12)} ${h.filePath} :: ${h.summary}`);
    }

    const binaryFiles = files.filter((f) => f.binary);
    if (binaryFiles.length) log(`binary files skipped: ${binaryFiles.map((f) => f.path).join(", ")}`);

    // Publish through the real pipeline, then re-publish to show dedupe.
    const published = new Set();
    const first = await publishHunks(hunks, published);
    log(`published: ${first.posted} new, ${first.skipped} skipped, errors=${first.errors.length}`);
    const second = await publishHunks(hunks, published);
    log(`re-publish: ${second.posted} new, ${second.skipped} skipped (dedupe works)`);

    return { sessionId: sim.session.id, hunks };
  } finally {
    sim.cleanup();
  }
}

async function livePhase() {
  log("=== Phase 2: live poll of the real AO daemon ===");
  const stats = await pollOnce();
  log(
    `live poll: sessions=${stats.sessions} files=${stats.files} hunks=${stats.hunks} posted=${stats.posted} skipped=${stats.skipped} errors=${stats.errors.length}`
  );
  for (const e of stats.errors) log(`  error: ${e}`);
  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("SwarmReview Listener demo");
  await healthCheck();

  const mode = process.argv.includes("--simulate")
    ? "simulate"
    : process.argv.includes("--live")
      ? "live"
      : "all";

  let simResult = null;
  if (mode === "simulate" || mode === "all") {
    try {
      simResult = await simulatePhase();
    } catch (e) {
      console.error(`[demo] simulate phase failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (mode === "live" || mode === "all") {
    try {
      await livePhase();
    } catch (e) {
      console.error(`[demo] live phase failed: ${e.message}`);
      process.exitCode = 1;
    }
  }

  // Final verification against the Data Layer
  log("=== Verification: GET /hunks on the Data Layer ===");
  const hunks = await listHunks();
  log(`total hunks in Data Layer: ${hunks.length}`);
  if (simResult) {
    const mine = hunks.filter((h) => h.sessionId === simResult.sessionId);
    log(`hunks from simulated session "${simResult.sessionId}": ${mine.length}`);
    for (const h of mine) {
      log(`  - ${h.id.slice(0, 12)} ${h.filePath} [${h.status}] :: ${h.summary}`);
    }
  }
  for (const h of hunks.slice(0, 5)) {
    log(`  sample: ${h.sessionId} ${h.filePath} [${h.status}] :: ${h.summary}`);
  }

  log(`done. Try: curl -s ${DATA_LAYER_URL}/hunks | python3 -m json.tool`);
}

main().catch((e) => {
  console.error("[demo] fatal:", e);
  process.exit(1);
});

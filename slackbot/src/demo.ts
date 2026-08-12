#!/usr/bin/env node
/**
 * Slack-free local demo for the SwarmReview digest builder.
 *
 * Renders the SAME digest (grouped per session, one card per hunk with
 * Approve / Reject / Comment) from real Data Layer data, and exercises the
 * approve / reject / revise decision flow end-to-end — no Slack credentials
 * required. The Bolt wiring in src/app.ts + src/bot.ts is the real-Slack path
 * and is env-driven; this demo exists so the integration can be demonstrated
 * and tested in this sandbox.
 *
 * Usage (run from slackbot/):
 *   npm run demo:seed            POST a few sample hunks to the Data Layer
 *   npm run demo:digest          print the digest to stdout + write digest.html
 *   npm run demo:serve           serve demo.html with live buttons on :4822
 *   npm run demo:review          interactive CLI: pick hunks, approve/reject/revise
 */

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, type Config } from "./config.ts";
import {
  DataLayer,
  type DecisionAction,
  type Hunk,
  type HunkStatus,
} from "./dataLayer.ts";
import { groupHunksBySession, renderTextDigest } from "./digest.ts";

const TEMPLATE_URL = new URL("../demo.html", import.meta.url);
const SNAPSHOT_PATH = new URL("../digest.html", import.meta.url);

const USAGE = `SwarmReview Slackbot — local demo

Usage: node src/demo.ts <command>

  seed     POST sample hunks to the Data Layer (idempotent-ish: unique ids per run)
  digest   Print the pending-hunks digest to stdout and write digest.html
  serve    Serve demo.html with live buttons (default http://127.0.0.1:4822)
  review   Interactive CLI: review hunks (approve / reject / revise) and verify decisions
  help     Show this message

Requires the Data Layer on http://127.0.0.1:4821 (cd db && node server.js).
`;

const [cmd] = process.argv.slice(2);

try {
  const config = loadConfig();
  const data = new DataLayer(config.dataUrl);
  switch (cmd) {
    case "seed":
      await seed(data);
      break;
    case "digest":
      await digest(data, config);
      break;
    case "serve":
      await serve(data, config);
      break;
    case "review":
      await review(data, config);
      break;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
  }
} catch (e) {
  console.error(`[demo] ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

async function seed(data: DataLayer): Promise<void> {
  const ts = Date.now();
  const samples: Array<{
    sessionId: string;
    agentName: string;
    filePath: string;
    diffText: string;
    summary: string;
  }> = [
    {
      sessionId: "review-tool-ao-2",
      agentName: "opencode",
      filePath: "src/client.ts",
      diffText: `@@ -12,7 +12,9 @@ export async function request(path: string) {
   const res = await fetch(BASE_URL + path, { method, headers });
   if (!res.ok && res.status >= 500) {
     // server hiccup: retry with backoff instead of failing the call
+    await sleep(250);
+    return await retryRequest(path, { ...options, attempt: 2 });
   }
   return res;
 }`,
      summary: "Add retry with backoff to the http client",
    },
    {
      sessionId: "review-tool-ao-2",
      agentName: "opencode",
      filePath: "docs/api.md",
      diffText: `@@ -8,6 +8,7 @@
 ## Endpoints
 
+### POST /decisions
+Records a human decision (approve | reject | revise) for a hunk.
+
 ## Errors`,
      summary: "Document the /decisions endpoint",
    },
    {
      sessionId: "review-tool-ao-3",
      agentName: "opencode",
      filePath: "package.json",
      diffText: `@@ -18,7 +18,7 @@
   "dependencies": {
-    "axios": "^0.27.2",
+    "axios": "^1.7.0",
     "express": "^4.19.0"
   }`,
      summary: "Pin axios to ^1.7.0 for the worker agents",
    },
  ];

  let created = 0;
  for (const s of samples) {
    const res = await data.postHunk({
      id: `demo-${ts}-${s.filePath.replace(/[^a-zA-Z0-9_.-]/g, "-")}`,
      sessionId: s.sessionId,
      agentName: s.agentName,
      filePath: s.filePath,
      diffText: s.diffText,
      summary: s.summary,
    });
    created += res.created ? 1 : 0;
    console.log(
      `[demo:seed] ${res.created ? "created" : "existing"} ${res.hunk.id} (${res.hunk.sessionId} :: ${res.hunk.filePath}) status=${res.hunk.status}`,
    );
  }
  console.log(
    `\nSeeded ${created} new hunk(s). View them: npm run demo:digest   |   decisions: curl http://127.0.0.1:4821/decisions`,
  );
}

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

async function digest(data: DataLayer, config: Config): Promise<void> {
  const hunks = await data.listHunks({ status: "pending" });
  const groups = groupHunksBySession(hunks);
  process.stdout.write(
    renderTextDigest(groups, {
      color: stdout.isTTY && !process.env.NO_COLOR,
      diffMaxChars: config.diffMaxChars,
    }),
  );

  const html = await snapshotHtml(clampHunkDiffs(hunks, config.diffMaxChars));
  await writeFile(SNAPSHOT_PATH, html, "utf8");
  console.log(
    `\nWrote ${SNAPSHOT_PATH.pathname.replace(/^.*\/slackbot\//, "slackbot/")} — open it in a browser, ` +
      `or run 'npm run demo:serve' for a live page with working buttons.`,
  );
}

/** Clamp huge diff snippets so the HTML page / API responses stay reasonable. */
function clampHunkDiffs(hunks: Hunk[], maxChars: number): Hunk[] {
  return hunks.map((h) => {
    if (h.diffText.length <= maxChars) return h;
    return { ...h, diffText: `${h.diffText.slice(0, maxChars)}\n… (truncated)` };
  });
}

async function snapshotHtml(hunks: Hunk[]): Promise<string> {
  const template = await readFile(TEMPLATE_URL, "utf8");
  const injection =
    `<script>\n` +
    `window.__SNAPSHOT__ = true;\n` +
    `window.__INITIAL_HUNKS__ = ${JSON.stringify(hunks).replace(/</g, "\\u003c")};\n` +
    `</script>\n`;
  // Inject right before the page's own script, which reads the two globals.
  return template.replace('<script>\n"use strict";', `${injection}<script>\n"use strict";`);
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serve(data: DataLayer, config: Config): Promise<void> {
  const page = await readFile(TEMPLATE_URL, "utf8");
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        sendJson(res, 200, page, "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && u.pathname.startsWith("/api/hunks")) {
        const status = (u.searchParams.get("status") as HunkStatus) || undefined;
        const hunks = await data.listHunks(status ? { status } : {});
        sendJson(res, 200, { hunks: clampHunkDiffs(hunks, config.diffMaxChars) });
        return;
      }
      if (req.method === "POST" && u.pathname === "/api/decisions") {
        const body = (await readJson(req)) as {
          hunkId?: string;
          action?: string;
          comment?: string;
        };
        if (!body.hunkId || !body.action) {
          sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "hunkId and action are required" } });
          return;
        }
        const result = await data.postDecision({
          hunkId: body.hunkId,
          action: body.action as DecisionAction,
          comment: body.comment,
        });
        sendJson(res, 201, result);
        return;
      }
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `demo route not found: ${u.pathname}` } });
    } catch (e) {
      sendJson(res, 500, { error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } });
    }
  });
  server.listen(config.demoPort, "127.0.0.1", () => {
    console.log(`[demo:serve] open http://127.0.0.1:${config.demoPort}/  (proxies decisions to ${config.dataUrl})`);
  });
}

// ---------------------------------------------------------------------------
// review — interactive CLI
// ---------------------------------------------------------------------------

/**
 * A prompt helper that works both interactively (TTY) and from piped stdin.
 * `readline/promises` hangs on the second question when stdin is a pipe that
 * reaches EOF, so for non-TTY input we read all lines upfront and serve them
 * from a queue (excess prompts get "").
 */
interface LineSource {
  question(promptText: string): Promise<string>;
  close(): void;
}

function createLineSource(): LineSource {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    return {
      async question(promptText: string): Promise<string> {
        process.stdout.write(promptText);
        const answer = await rl.question("");
        return answer;
      },
      close() {
        rl.close();
      },
    };
  }
  const lines = readFileSync(0, "utf8").split(/\r?\n/);
  let i = 0;
  return {
    async question(promptText: string): Promise<string> {
      process.stdout.write(promptText);
      const line = i < lines.length ? lines[i] : "";
      i += 1;
      return line;
    },
    close() {
      // nothing to close — stdin was already consumed
    },
  };
}

async function review(data: DataLayer, config: Config): Promise<void> {
  const line = createLineSource();
  try {
    for (;;) {
      const hunks = await data.listHunks({ status: "pending" });
      if (hunks.length === 0) {
        console.log("\nNo pending hunks. Seed some: npm run demo:seed");
        break;
      }
      console.log("\nPending hunks:");
      hunks.forEach((h, i) => {
        console.log(`  [${i + 1}] ${h.sessionId} :: ${h.filePath} — ${h.summary}`);
      });
      const pick = (
        await line.question("\nPick a hunk to review (number), r to refresh, q to quit: ")
      ).trim();
      if (pick.toLowerCase() === "q") break;
      if (pick.toLowerCase() === "r") continue;
      const idx = Number(pick) - 1;
      const hunk = hunks[idx];
      if (!hunk) {
        console.log("Invalid selection.");
        continue;
      }
      console.log(
        `\nHunk ${hunk.id}\n  ${hunk.filePath}\n  ${hunk.summary}\n---\n${truncate(hunk.diffText, config.diffMaxChars)}\n---`,
      );
      const actionRaw = (
        await line.question("Action: a (approve) | r (reject) | c (comment/revise): ")
      )
        .trim()
        .toLowerCase();
      let action: DecisionAction | undefined;
      if (["a", "approve"].includes(actionRaw)) action = "approve";
      else if (["r", "reject"].includes(actionRaw)) action = "reject";
      else if (["c", "revise", "comment"].includes(actionRaw)) action = "revise";
      else {
        console.log(`Unknown action: ${actionRaw}`);
        continue;
      }

      let comment: string | undefined;
      if (action === "revise") {
        comment = (await line.question("Comment (required for revise): ")).trim();
        if (!comment) {
          console.log("A comment is required for revise — skipping.");
          continue;
        }
      } else if (action === "reject") {
        const c = (await line.question("Optional reject comment (Enter to skip): ")).trim();
        if (c) comment = c;
      }

      try {
        const result = await data.postDecision({ hunkId: hunk.id, action, comment });
        console.log(`-> ${action} recorded: hunk ${hunk.id} now ${result.hunk.status}`);
      } catch (e) {
        console.log(`! ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    line.close();
    const decisions = await data.listDecisions();
    if (decisions.length > 0) {
      console.log(`\nDecisions recorded (${decisions.length}):`);
      for (const d of decisions) {
        console.log(
          `  ${d.action} ${d.hunkId}${d.comment ? ` — "${d.comment}"` : ""} @ ${d.decidedAt}`,
        );
      }
      console.log("\nVerify with: curl http://127.0.0.1:4821/decisions");
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\u2026 (truncated)` : s;
}

function sendJson(res: ServerResponse, code: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  res.writeHead(code, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

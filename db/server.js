#!/usr/bin/env node
/**
 * SwarmReview Data Layer — zero-dependency Node service.
 * Implements the FROZEN contract in db/schema.md (REST + SSE over SQLite).
 * Uses Node built-ins only: node:http, node:sqlite, node:crypto.
 *
 * Run:  node server.js            (default port 4821, db ./swarmreview.db)
 * Env:  SWARMREVIEW_PORT          override port
 *       SWARMREVIEW_DB            override sqlite path (default ./swarmreview.db)
 */
"use strict";

const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.SWARMREVIEW_PORT || 4821);
const DB_PATH = process.env.SWARMREVIEW_DB || path.join(__dirname, "swarmreview.db");

// ---------------------------------------------------------------------------
// SQLite init (applies frozen DDL)
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent_name      TEXT NOT NULL DEFAULT '',
  branch          TEXT NOT NULL DEFAULT '',
  first_seen_at   TEXT NOT NULL,
  last_updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hunks (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  diff_text  TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','approved','rejected','needs_revision')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hunks_status ON hunks (status);
CREATE INDEX IF NOT EXISTS idx_hunks_session ON hunks (session_id);
CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  hunk_id    TEXT NOT NULL REFERENCES hunks (id),
  action     TEXT NOT NULL CHECK (action IN ('approve','reject','revise')),
  comment    TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_hunk ON decisions (hunk_id);
`);

const now = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;
const hashId = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);

const stmts = {
  upsertSession: db.prepare(
    `INSERT INTO sessions (id, agent_name, branch, first_seen_at, last_updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agent_name = excluded.agent_name,
       branch = excluded.branch,
       last_updated_at = excluded.last_updated_at`
  ),
  insertHunk: db.prepare(
    `INSERT INTO hunks (id, session_id, agent_name, file_path, diff_text, summary, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ),
  getHunk: db.prepare(`SELECT * FROM hunks WHERE id = ?`),
  listHunks: db.prepare(
    `SELECT * FROM hunks
     WHERE (? = '' OR status = ?)
       AND (? = '' OR session_id = ?)
       AND (? = '' OR agent_name = ?)
       AND (? = '' OR file_path = ?)
     ORDER BY created_at DESC`
  ),
  insertDecision: db.prepare(
    `INSERT INTO decisions (id, hunk_id, action, comment, decided_at) VALUES (?, ?, ?, ?, ?)`
  ),
  setHunkStatus: db.prepare(`UPDATE hunks SET status = ?, updated_at = ? WHERE id = ?`),
  listDecisions: db.prepare(
    `SELECT * FROM decisions
     WHERE (? = '' OR hunk_id = ?) AND (? = '' OR action = ?)
     ORDER BY decided_at DESC`
  ),
  listSessions: db.prepare(`SELECT * FROM sessions ORDER BY last_updated_at DESC`),
  getDecisionByHunk: db.prepare(`SELECT * FROM decisions WHERE hunk_id = ? ORDER BY decided_at DESC LIMIT 1`),
};

// ---------------------------------------------------------------------------
// SSE subscribers
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) {
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

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function err(res, code, message, httpCode = 400) {
  json(res, httpCode, { error: { code, message } });
}

function hunkRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    agentName: row.agent_name,
    filePath: row.file_path,
    diffText: row.diff_text,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decisionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    hunkId: row.hunk_id,
    action: row.action,
    comment: row.comment || undefined,
    decidedAt: row.decided_at,
  };
}

async function postHunks(req, res) {
  const b = await readBody(req);
  if (!b.sessionId || typeof b.sessionId !== "string") return err(res, "SESSION_ID_REQUIRED", "sessionId is required");
  if (!b.filePath || typeof b.filePath !== "string") return err(res, "FILE_PATH_REQUIRED", "filePath is required");
  if (!b.diffText || typeof b.diffText !== "string") return err(res, "DIFF_TEXT_REQUIRED", "diffText is required");

  const sessionId = b.sessionId;
  const agentName = typeof b.agentName === "string" && b.agentName ? b.agentName : sessionId;
  const filePath = b.filePath;
  const diffText = b.diffText;
  const summary = typeof b.summary === "string" ? b.summary : "";
  const id = typeof b.id === "string" && b.id ? b.id : hashId(`${sessionId}|${filePath}|${diffText}`);
  const branch = typeof b.branch === "string" ? b.branch : "";
  const ts = now();

  stmts.upsertSession.run(sessionId, agentName, branch, ts, ts);
  const existing = stmts.getHunk.get(id);
  if (existing) {
    return json(res, 200, { hunk: hunkRow(existing), created: false });
  }
  stmts.insertHunk.run(id, sessionId, agentName, filePath, diffText, summary, ts, ts);
  const hunk = hunkRow(stmts.getHunk.get(id));
  broadcast("hunk", { hunk });
  json(res, 201, { hunk, created: true });
}

function getHunks(req, res) {
  const u = new URL(req.url, "http://x");
  const status = u.searchParams.get("status") || "";
  const sessionId = u.searchParams.get("sessionId") || "";
  const agentName = u.searchParams.get("agentName") || "";
  const filePath = u.searchParams.get("filePath") || "";
  const rows = stmts.listHunks.all(status, status, sessionId, sessionId, agentName, agentName, filePath, filePath);
  json(res, 200, { hunks: rows.map(hunkRow) });
}

function getHunkById(req, res, id) {
  const row = stmts.getHunk.get(id);
  if (!row) return err(res, "HUNK_NOT_FOUND", "hunk not found", 404);
  json(res, 200, { hunk: hunkRow(row) });
}

async function postDecisions(req, res) {
  const b = await readBody(req);
  if (!b.hunkId || typeof b.hunkId !== "string") return err(res, "HUNK_ID_REQUIRED", "hunkId is required");
  if (!["approve", "reject", "revise"].includes(b.action)) {
    return err(res, "INVALID_ACTION", "action must be approve|reject|revise", 422);
  }
  if (b.action === "revise" && !(typeof b.comment === "string" && b.comment.trim())) {
    return err(res, "COMMENT_REQUIRED", "comment is required for action=revise", 422);
  }

  const hunk = stmts.getHunk.get(b.hunkId);
  if (!hunk) return err(res, "HUNK_NOT_FOUND", "hunk not found", 404);

  const prior = stmts.getDecisionByHunk.get(b.hunkId);
  if (prior) {
    return err(
      res,
      "HUNK_ALREADY_DECIDED",
      `hunk already decided: ${prior.action}`,
      409
    );
  }

  const statusMap = { approve: "approved", reject: "rejected", revise: "needs_revision" };
  const comment = typeof b.comment === "string" ? b.comment : "";
  const decidedAt = now();
  const decisionId = uid("dec");
  stmts.insertDecision.run(decisionId, b.hunkId, b.action, comment, decidedAt);
  stmts.setHunkStatus.run(statusMap[b.action], now(), b.hunkId);

  const decision = decisionRow(stmts.getDecisionByHunk.get(b.hunkId));
  const updated = hunkRow(stmts.getHunk.get(b.hunkId));
  broadcast("decision", { decision, hunk: updated });
  json(res, 201, { decision, hunk: updated });
}

function getDecisions(req, res) {
  const u = new URL(req.url, "http://x");
  const hunkId = u.searchParams.get("hunkId") || "";
  const action = u.searchParams.get("action") || "";
  const rows = stmts.listDecisions.all(hunkId, hunkId, action, action);
  json(res, 200, { decisions: rows.map(decisionRow) });
}

function getSessions(req, res) {
  json(res, 200, {
    sessions: stmts.listSessions.all().map((r) => ({
      id: r.id,
      agentName: r.agent_name,
      branch: r.branch,
      firstSeenAt: r.first_seen_at,
      lastUpdatedAt: r.last_updated_at,
    })),
  });
}

function getStats(req, res) {
  const all = stmts.listHunks.all("", "", "", "", "", "", "", "");
  const count = (rows, s) => rows.filter((r) => r.status === s).length;
  const byAgent = new Map();
  const bySession = new Map();
  for (const r of all) {
    if (!byAgent.has(r.agent_name)) byAgent.set(r.agent_name, { pending: 0, approved: 0, rejected: 0, needsRevision: 0 });
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, { pending: 0, approved: 0, rejected: 0, needsRevision: 0 });
    const a = byAgent.get(r.agent_name);
    const s = bySession.get(r.session_id);
    if (r.status === "pending") { a.pending++; s.pending++; }
    else if (r.status === "approved") { a.approved++; s.approved++; }
    else if (r.status === "rejected") { a.rejected++; s.rejected++; }
    else if (r.status === "needs_revision") { a.needsRevision++; s.needsRevision++; }
  }
  json(res, 200, {
    totalHunks: all.length,
    pending: count(all, "pending"),
    approved: count(all, "approved"),
    rejected: count(all, "rejected"),
    needsRevision: count(all, "needs_revision"),
    byAgent: [...byAgent.entries()].map(([agentName, v]) => ({ agentName, ...v })),
    bySession: [...bySession.entries()].map(([sessionId, v]) => ({ sessionId, ...v })),
  });
}

function events(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepalive);
      sseClients.delete(res);
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (req.method === "GET" && p === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && p === "/events") return events(req, res);
    if (req.method === "POST" && p === "/hunks") return await postHunks(req, res);
    if (req.method === "GET" && p === "/hunks") return getHunks(req, res);
    const hunkMatch = p.match(/^\/hunks\/([^/]+)$/);
    if (req.method === "GET" && hunkMatch) return getHunkById(req, res, decodeURIComponent(hunkMatch[1]));
    if (req.method === "POST" && p === "/decisions") return await postDecisions(req, res);
    if (req.method === "GET" && p === "/decisions") return getDecisions(req, res);
    if (req.method === "GET" && p === "/sessions") return getSessions(req, res);
    if (req.method === "GET" && p === "/stats") return getStats(req, res);
    return err(res, "ROUTE_NOT_FOUND", `${req.method} ${p} has no handler`, 404);
  } catch (e) {
    if (e.message === "invalid JSON body") return err(res, "INVALID_JSON", e.message, 400);
    if (e.message === "body too large") return err(res, "BODY_TOO_LARGE", e.message, 413);
    console.error("[swarmreview-db]", e);
    return err(res, "INTERNAL", "internal error", 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[swarmreview-db] Data Layer listening on http://127.0.0.1:${PORT}`);
  console.log(`[swarmreview-db] sqlite: ${DB_PATH}`);
});

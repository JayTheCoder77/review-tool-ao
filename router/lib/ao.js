"use strict";
/**
 * AO daemon client — the ONE place the Router talks to the AO daemon.
 * Research (verified live, see router/README.md):
 *   - GET  /api/v1/sessions                  -> { sessions: [{id, projectId, branch, harness, ...}] }
 *   - GET  /api/v1/projects                  -> { projects: [{id, name, path, ...}] }
 *   - POST /api/v1/sessions/{id}/send        {"message":"..."} -> {"ok":true,...}   (steer the agent)
 *
 * The daemon exposes no git primitive for "commit/discard a hunk" — the router
 * drives git directly on the session worktree (see lib/worktree.js + lib/git.js).
 */
const { getJson, postJson } = require("./http");

function baseUrl() {
  if (process.env.AO_API_URL) return process.env.AO_API_URL.replace(/\/$/, "");
  const port = process.env.AO_PORT || "3001";
  return `http://127.0.0.1:${port}`;
}

/** GET /api/v1/sessions -> [session, ...] */
async function getSessions() {
  const body = await getJson(`${baseUrl()}/api/v1/sessions`);
  return body.sessions || [];
}

/** GET /api/v1/projects -> [project, ...] */
async function getProjects() {
  const body = await getJson(`${baseUrl()}/api/v1/projects`);
  return body.projects || [];
}

/** Find one session by id; null if absent. */
async function findSession(sessionId) {
  const sessions = await getSessions();
  return sessions.find((s) => s.id === sessionId) || null;
}

/**
 * POST /api/v1/sessions/{id}/send — inject a message into the agent session
 * (the equivalent of `ao send --session <id> --message "<text>"`).
 * Returns the daemon response; throws HttpError on failure (e.g. 404 unknown session).
 */
async function sendMessage(sessionId, message) {
  return postJson(`${baseUrl()}/api/v1/sessions/${encodeURIComponent(sessionId)}/send`, {
    message,
  });
}

module.exports = { baseUrl, getSessions, getProjects, findSession, sendMessage };
"use strict";
/**
 * SwarmReview Data Layer client.
 * Talks ONLY to the Data Layer REST + SSE API (frozen contract in db/schema.md):
 *   - GET /hunks/:id          resolve a hunk (sessionId, filePath, diffText, ...)
 *   - GET /decisions          poll fallback for the Router
 *   - GET /events (SSE)       decision event feed the Router subscribes to
 *
 * Base URL defaults to http://127.0.0.1:4821 (SWARMREVIEW_PORT / SWARMREVIEW_DATA_URL).
 */
const path = require("node:path");
const { getJson, postJson } = require("./http");
const { subscribeDecisionStream } = require("./sse");

function baseUrl() {
  if (process.env.SWARMREVIEW_DATA_URL) return process.env.SWARMREVIEW_DATA_URL.replace(/\/$/, "");
  const port = process.env.SWARMREVIEW_PORT || "4821";
  return `http://127.0.0.1:${port}`;
}

/** GET /hunks/:id -> Hunk (throws HttpError with status 404 if unknown). */
async function getHunk(hunkId) {
  const body = await getJson(`${baseUrl()}/hunks/${encodeURIComponent(hunkId)}`);
  return body.hunk;
}

/** GET /decisions -> [Decision, ...] (newest first). */
async function listDecisions() {
  const body = await getJson(`${baseUrl()}/decisions`);
  return body.decisions || [];
}

/** POST /hunks -> created/returned Hunk (idempotent by id). */
async function postHunk({ id, sessionId, agentName, filePath, diffText, summary, branch }) {
  const body = await postJson(`${baseUrl()}/hunks`, {
    id,
    sessionId,
    agentName,
    filePath,
    diffText,
    summary,
    branch,
  });
  return body.hunk;
}

/** POST /decisions -> { decision, hunk } (throws on 409/422/404). */
async function postDecision({ hunkId, action, comment }) {
  const body = await postJson(`${baseUrl()}/decisions`, { hunkId, action, comment });
  return body;
}

/**
 * Subscribe to the Data Layer decision feed.
 * Returns { close }; the caller re-subscribes via onError/onClose (see router.js).
 */
function subscribeDecisions({ onDecision, onError, onClose, onOpen }) {
  return subscribeDecisionStream({
    baseUrl: baseUrl(),
    types: "decision",
    onDecision,
    onError,
    onClose,
    onOpen,
  });
}

module.exports = {
  baseUrl,
  getHunk,
  listDecisions,
  postHunk,
  postDecision,
  subscribeDecisions,
};

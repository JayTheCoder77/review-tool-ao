"use strict";
/**
 * Resolve a hunk's AO session to its git worktree path.
 *
 * Worktrees live at  ~/.ao/data/worktrees/<projectId>/<sessionId>/  (verified live).
 * projectId comes from the session record (`GET /api/v1/sessions` -> session.projectId)
 * or, if the session is gone, is inferred by longest-prefix matching against
 * `GET /api/v1/projects` (session "review-tool-ao-2" -> project "review-tool-ao").
 *
 * Precedence (useful for demo/testing):
 *   1. ctx.worktreeOverrides[hunk.sessionId]      (programmatic, see demo.js)
 *   2. SWARMREVIEW_WORKTREE_OVERRIDES env         ("s1=/path;s2=/path")
 *   3. AO daemon session/project lookup + SWARMREVIEW_AO_WORKTREES_ROOT (default ~/.ao/data/worktrees)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertGitRepo } = require("./git");

const DEFAULT_WORKTREES_ROOT = path.join(os.homedir(), ".ao", "data", "worktrees");

/** Parse "sess1=/a;sess2=/b" into {sess1:"/a", sess2:"/b"}. */
function parseWorktreeOverrides(str) {
  const map = {};
  if (!str) return map;
  for (const pair of str.split(/[;]/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

/**
 * @param {object} hunk  Hunk from the Data Layer (sessionId required)
 * @param {object} ctx   { ao, worktreeOverrides?, worktreesRoot? }
 * @returns {Promise<{ path: string, source: string, branch?: string }>}
 * @throws Error with a human-readable explanation when the worktree cannot be found.
 */
async function resolveWorktree(hunk, ctx) {
  const sessionId = hunk.sessionId;
  if (!sessionId) throw new Error(`hunk ${hunk.id} has no sessionId`);

  const overrides = { ...parseWorktreeOverrides(process.env.SWARMREVIEW_WORKTREE_OVERRIDES), ...(ctx.worktreeOverrides || {}) };
  if (overrides[sessionId]) {
    const p = path.resolve(overrides[sessionId]);
    const err = assertGitRepo(p);
    if (err) throw err;
    return { path: p, source: "override" };
  }

  // AO daemon resolution.
  const ao = ctx.ao;
  let projectId = null;
  let branch = null;
  let session = null;
  try {
    session = await ao.findSession(sessionId);
  } catch (e) {
    throw new Error(`cannot query AO daemon for session "${sessionId}": ${e.message}`);
  }
  if (session) {
    projectId = session.projectId || null;
    branch = session.branch || null;
  }
  if (!projectId) {
    let projects = [];
    try {
      projects = await ao.getProjects();
    } catch (e) {
      projects = [];
    }
    const match = projects
      .filter((p) => sessionId === p.id || sessionId.startsWith(`${p.id}-`))
      .sort((a, b) => b.id.length - a.id.length)[0];
    projectId = match ? match.id : null;
  }
  if (!projectId) {
    throw new Error(
      `no AO session "${sessionId}" and could not infer a projectId — is the session running? ` +
        `(override worktree with SWARMREVIEW_WORKTREE_OVERRIDES="${sessionId}=/path/to/worktree")`
    );
  }

  const root = ctx.worktreesRoot || process.env.SWARMREVIEW_AO_WORKTREES_ROOT || DEFAULT_WORKTREES_ROOT;
  const dir = path.join(root, projectId, sessionId);
  if (!fs.existsSync(dir)) {
    throw new Error(`worktree missing for session "${sessionId}": ${dir}`);
  }
  const err = assertGitRepo(dir);
  if (err) throw err;
  return { path: dir, source: "ao-daemon", branch, session };
}

module.exports = { resolveWorktree, parseWorktreeOverrides, DEFAULT_WORKTREES_ROOT };
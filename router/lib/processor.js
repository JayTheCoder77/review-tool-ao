"use strict";
/**
 * Decision processor — the heart of the Router.
 *
 * For every decision { hunkId, action, comment? }:
 *   1. resolve the hunk          (Data Layer GET /hunks/:hunkId)
 *   2. resolve the worktree      (AO daemon + ~/.ao/data/worktrees, or overrides for demo)
 *   3. dispatch on action:
 *        approve -> git apply --cached + git commit  (only the hunk; never amend/force-push)
 *        reject  -> git apply -R (reverse-apply); on conflict, fall back to steering the agent via /send
 *        revise  -> (optionally reverse-apply first) + /send reviewer comment + "revise filePath and re-propose"
 *
 * This module is deliberately independent of the subscribe/poll loop so both
 * router.js and demo.js can drive it.
 */
const git = require("./git");
const { resolveWorktree } = require("./worktree");

const HUNK_NOT_FOUND = "HUNK_NOT_FOUND";

/**
 * @param {object} decision  { id, hunkId, action, comment?, decidedAt }
 * @param {object} ctx {
 *   datalayer:      Data Layer client (getHunk)
 *   ao:             AO daemon client (sendMessage)
 *   worktreeOverrides?: map sessionId -> absolute worktree path (demo)
 *   worktreesRoot?:     override base dir for ~/.ao/data/worktrees
 *   log?:               (level, msg) => void   default console
 *   notifyOnApprove?:   send a /send message to the agent after committing (default true)
 *   reverseApplyOnRevise?: reverse-apply the hunk before steering (default true)
 *   dryRun?:            log instead of touching git / the daemon
 * }
 * @returns {Promise<object>} result record (ok, action, worktree?, commitSha?, messages, error?)
 */
async function processDecision(decision, ctx) {
  const log = ctx.log || console.log;
  const wrap = (res) => ({ ...res, decisionId: decision.id, hunkId: decision.hunkId, action: decision.action });

  if (!decision || !decision.hunkId) {
    return wrap({ ok: false, error: "decision missing hunkId" });
  }

  let hunk;
  try {
    hunk = await ctx.datalayer.getHunk(decision.hunkId);
  } catch (e) {
    const error =
      e.status === 404
        ? `${HUNK_NOT_FOUND}: hunk "${decision.hunkId}" is not in the Data Layer`
        : `could not resolve hunk "${decision.hunkId}": ${e.message}`;
    return wrap({ ok: false, error });
  }

  let wt;
  try {
    wt = await resolveWorktree(hunk, ctx);
  } catch (e) {
    return wrap({ ok: false, error: e.message });
  }
  log(`[router] session ${hunk.sessionId} -> worktree ${wt.path} (${wt.source})`);

  switch (decision.action) {
    case "approve":
      return wrap(await approve(hunk, wt, decision, ctx, log));
    case "reject":
      return wrap(await reject(hunk, wt, decision, ctx, log));
    case "revise":
      return wrap(await revise(hunk, wt, decision, ctx, log));
    default:
      return wrap({ ok: false, error: `unknown action "${decision.action}"` });
  }
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------
async function approve(hunk, wt, decision, ctx, log) {
  const patchFile = git.writePatchFile(hunk.diffText, hunk.id);
  const notifyOnApprove = ctx.notifyOnApprove !== false;
  try {
    if (ctx.dryRun) {
      log(`[router][dry-run] approve ${hunk.id}: would stage+commit ${hunk.filePath} in ${wt.path}`);
      return { ok: true, dryRun: true, worktree: wt.path, filePath: hunk.filePath };
    }
    const applied = git.applyPatchCached(wt.path, patchFile);
    if (!applied.ok) {
      const msg =
        `Hunk ${hunk.id} was approved, but the patch no longer applies cleanly to ` +
        `your worktree (${hunk.filePath}). Conflict: ${applied.error}. ` +
        `Please reconcile the change and commit/re-propose it — do not re-apply an older patch.`;
      await safeSend(ctx.ao, hunk.sessionId, msg, log, "approve-conflict");
      return { ok: false, error: `patch did not apply: ${applied.error}`, steered: true, worktree: wt.path };
    }
    const commitMsg = `swarmreview: apply hunk ${hunk.id} (approved)`;
    const committed = git.commitHunk(wt.path, hunk.filePath, commitMsg);
    if (!committed.ok) {
      const msg =
        `Hunk ${hunk.id} was approved and staged, but committing failed in my worktree ` +
        `(${hunk.filePath}). Error: ${committed.error}. Please commit the change yourself.`;
      await safeSend(ctx.ao, hunk.sessionId, msg, log, "approve-commit-failed");
      return { ok: false, error: `commit failed: ${committed.error}`, worktree: wt.path };
    }
    if (notifyOnApprove) {
      const msg =
        `Hunk ${hunk.id} (${hunk.filePath}) was approved by the reviewer and committed ` +
        `to your branch as ${committed.sha ? "commit " + committed.sha.slice(0, 8) : "a new commit"}.`;
      await safeSend(ctx.ao, hunk.sessionId, msg, log, "approve-notify");
    }
    return {
      ok: true,
      worktree: wt.path,
      filePath: hunk.filePath,
      commitSha: committed.sha,
      stagedPaths: committed.committedPaths,
      message: commitMsg,
    };
  } finally {
    git.cleanupPatchFile(patchFile);
  }
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------
async function reject(hunk, wt, decision, ctx, log) {
  const patchFile = git.writePatchFile(hunk.diffText, hunk.id);
  try {
    if (ctx.dryRun) {
      log(`[router][dry-run] reject ${hunk.id}: would reverse-apply ${hunk.filePath} in ${wt.path}`);
      return { ok: true, dryRun: true, worktree: wt.path, filePath: hunk.filePath };
    }
    const reversed = git.reverseApplyPatch(wt.path, patchFile);
    if (reversed.ok) {
      log(`[router] rejected hunk ${hunk.id}: reverse-applied ${hunk.filePath} in ${wt.path}`);
      const msg =
        `Hunk ${hunk.id} (${hunk.filePath}) was rejected by the reviewer and has been ` +
        `reverted in your worktree. Keep the rest of your work as-is.`;
      await safeSend(ctx.ao, hunk.sessionId, msg, log, "reject-notify");
      return { ok: true, worktree: wt.path, filePath: hunk.filePath, reverted: true };
    }
    // Reverse-apply conflicted (agent changed the file afterwards) -> steer the agent.
    const comment = decision.comment ? ` Reviewer comment: "${decision.comment}"` : "";
    const msg =
      `Hunk ${hunk.id} (${hunk.filePath}) was rejected by the reviewer.` +
      `${comment} Your later edits conflict with a clean revert, so please discard ` +
      `this change in your worktree yourself and re-propose if needed.`;
    await safeSend(ctx.ao, hunk.sessionId, msg, log, "reject-conflict");
    return {
      ok: false,
      error: `reverse-apply conflicted: ${reversed.error}`,
      steered: true,
      worktree: wt.path,
    };
  } finally {
    git.cleanupPatchFile(patchFile);
  }
}

// ---------------------------------------------------------------------------
// revise
// ---------------------------------------------------------------------------
async function revise(hunk, wt, decision, ctx, log) {
  const reverseApplyOnRevise = ctx.reverseApplyOnRevise !== false;
  const comment = (decision.comment || "").trim();

  let reverted = false;
  if (reverseApplyOnRevise) {
    const patchFile = git.writePatchFile(hunk.diffText, hunk.id);
    try {
      if (!ctx.dryRun) {
        const r = git.reverseApplyPatch(wt.path, patchFile);
        reverted = r.ok;
        if (!r.ok) log(`[router] revise: reverse-apply skipped (${r.error})`);
      }
    } finally {
      git.cleanupPatchFile(patchFile);
    }
  }

  const feedback = comment ? `Reviewer feedback: ${comment}` : "Reviewer requested a revision.";
  const msg =
    `${feedback}\n\nPlease revise "${hunk.filePath}" accordingly and re-propose the change ` +
    `(a fresh hunk will be collected from your worktree diff).` +
    (reverted ? " The previous version has been reverted in your worktree." : "");

  if (ctx.dryRun) {
    log(`[router][dry-run] revise ${hunk.id}: would send to ${hunk.sessionId}: ${msg.replace(/\n/g, " ")}`);
    return { ok: true, dryRun: true, worktree: wt.path, filePath: hunk.filePath, reverted };
  }

  await safeSend(ctx.ao, hunk.sessionId, msg, log, "revise");
  return { ok: true, worktree: wt.path, filePath: hunk.filePath, reverted, messageSent: msg };
}

/** Send a message to the agent, tolerating daemon/session errors (never fatal). */
async function safeSend(ao, sessionId, message, log, tag) {
  if (!ao) return { sent: false, error: "no ao client" };
  try {
    const res = await ao.sendMessage(sessionId, message);
    log(`[router] ${tag}: message sent to ${sessionId} (ok=${Boolean(res && res.ok)})`);
    return { sent: true, res };
  } catch (e) {
    log(`[router] ${tag}: could not message ${sessionId}: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

module.exports = { processDecision, HUNK_NOT_FOUND };
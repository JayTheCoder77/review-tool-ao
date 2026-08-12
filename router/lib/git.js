"use strict";
/**
 * git operations the Router performs on an AO session worktree.
 *
 * Semantics (empirically verified — see router/README.md "recommended flow"):
 *   approve -> `git apply --cached <patch>` (stages ONLY this hunk's lines into
 *              the index; the agent's other working-tree edits stay untouched),
 *              then `git commit` so exactly the hunk lands on the session branch.
 *   reject  -> `git apply -R <patch>` reverse-applies the hunk off the working
 *              tree. If the file moved on afterwards this may conflict — the
 *              caller falls back to steering the agent via /send.
 *
 * Safety: we never `git reset --hard`, never amend, never force-push.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GIT_TIMEOUT_MS = Number(process.env.SWARMREVIEW_GIT_TIMEOUT_MS || 60000);

/** Run git in `cwd`; returns { ok, code, stdout, stderr, output }. */
function runGit(args, cwd) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  const ok = res.status === 0 && !res.error;
  return { ok, code: res.status, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim(), error: res.error };
}

/** Verify the directory is a git worktree (clear error otherwise). */
function assertGitRepo(dir) {
  const r = runGit(["rev-parse", "--is-inside-work-tree"], dir);
  if (!r.ok || r.stdout !== "true") {
    return new Error(`not a git worktree: ${dir} (${r.stderr || r.stdout || r.error})`);
  }
  return null;
}

/** Write hunk.diffText to a temp .patch file. Returns the absolute path. */
function writePatchFile(diffText, hunkId) {
  const safeId = String(hunkId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const p = path.join(os.tmpdir(), `swarmreview-${safeId}-${process.pid}-${Date.now()}.patch`);
  // `git apply` rejects a patch whose final line has no newline; diffs stored
  // by producers that trim trailing whitespace end up newline-less, so normalize.
  let text = diffText;
  if (!text.endsWith("\n")) text += "\n";
  fs.writeFileSync(p, text, "utf8");
  return p;
}

function cleanupPatchFile(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** Extra commit identity used only when the worktree has no git identity configured. */
function identityArgs() {
  const name = process.env.SWARMREVIEW_GIT_AUTHOR_NAME || "SwarmReview Router";
  const email = process.env.SWARMREVIEW_GIT_AUTHOR_EMAIL || "router@swarmreview.local";
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/**
 * Stage the hunk into the index (`git apply --cached`).
 * Falls back to `--3way` merge against the index when plain apply conflicts.
 * Returns { ok, error?, used3way }.
 */
function applyPatchCached(worktree, patchFile) {
  const plain = runGit(["apply", "--cached", "--whitespace=nowarn", patchFile], worktree);
  if (plain.ok) return { ok: true, used3way: false };
  const three = runGit(["apply", "--cached", "--3way", "--whitespace=nowarn", patchFile], worktree);
  if (three.ok) return { ok: true, used3way: true };
  return { ok: false, used3way: false, error: three.stderr || plain.stderr || "git apply --cached failed" };
}

/**
 * Commit ONLY the hunk: the index holds exactly what we staged, so a plain
 * commit is correct. If the worktree had OTHER pre-staged paths (rare for AO
 * sessions), restrict with an explicit pathspec so they are not swept in.
 * Returns { ok, sha?, error?, committedPaths, alreadyPresent? }.
 */
function commitHunk(worktree, filePath, message) {
  const staged = runGit(["diff", "--cached", "--name-only"], worktree);
  const stagedPaths = staged.ok ? staged.stdout.split("\n").filter(Boolean) : [];
  const otherStaged = stagedPaths.filter((p) => p !== filePath);
  // NOTE: `-c user.*` are top-level git options and must precede the `commit`
  // subcommand, so identity args are injected at the FRONT  of the argv list.
  const buildArgs = (identity) => [
    ...(identity ? identityArgs() : []),
    "commit",
    "-m",
    message,
    "--no-verify",
    "-q",
    ...(otherStaged.length ? ["--", filePath] : []),
  ];
  const res = runGit(buildArgs(false), worktree);
  if (res.ok) {
    const rev = runGit(["rev-parse", "HEAD"], worktree);
    return { ok: true, sha: rev.ok ? rev.stdout : null, committedPaths: otherStaged.length ? [filePath] : stagedPaths.length ? stagedPaths : [filePath] };
  }
  // "nothing to commit" (with -q this lands on stdout) means the hunk is
  // already in the tree — e.g. the agent committed it, or a 3-way merge no-op'd.
  if (/nothing (added )?to commit|nothing to commit/i.test(`${res.stdout} ${res.stderr}`)) {
    const rev = runGit(["rev-parse", "HEAD"], worktree);
    return { ok: true, alreadyPresent: true, sha: rev.ok ? rev.stdout : null, committedPaths: stagedPaths.length ? stagedPaths : [filePath] };
  }
  // Commit can fail because the worktree lacks a git identity — retry once with one.
  const retry = runGit(buildArgs(true), worktree);
  if (retry.ok) {
    const rev = runGit(["rev-parse", "HEAD"], worktree);
    return { ok: true, sha: rev.ok ? rev.stdout : null, committedPaths: otherStaged.length ? [filePath] : stagedPaths.length ? stagedPaths : [filePath], identityInjected: true };
  }
  // Don't leave the hunk staged AND uncommitted silently: report so the agent
  // can be steered instead.
  return { ok: false, error: res.stderr || retry.stderr || "git commit failed", committedPaths: stagedPaths };
}

/**
 * Reverse-apply the hunk off the working tree (`git apply -R`).
 * Returns { ok, error?, used3way }.
 */
function reverseApplyPatch(worktree, patchFile) {
  const plain = runGit(["apply", "-R", "--whitespace=nowarn", patchFile], worktree);
  if (plain.ok) return { ok: true, used3way: false };
  const three = runGit(["apply", "-R", "--3way", "--whitespace=nowarn", patchFile], worktree);
  if (three.ok) return { ok: true, used3way: true };
  return { ok: false, used3way: false, error: three.stderr || plain.stderr || "git apply -R failed" };
}

/** Working-tree status (porcelain v1), for demo verification + logging. */
function statusPorcelain(worktree) {
  const r = runGit(["status", "--porcelain"], worktree);
  return r.ok ? r.stdout : "";
}

module.exports = {
  assertGitRepo,
  writePatchFile,
  cleanupPatchFile,
  applyPatchCached,
  commitHunk,
  reverseApplyPatch,
  statusPorcelain,
  runGit,
};
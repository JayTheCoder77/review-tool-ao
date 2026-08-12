"use strict";
/**
 * hunks.js — pure helpers for splitting AO session file diffs into hunks.
 *
 * The AO daemon exposes, per changed file, a full unified git diff
 * (GET /api/v1/sessions/{id}/workspace/file?path=<rel> → `diff`). There is no
 * per-hunk endpoint, so the Listener splits that diff into hunks itself.
 *
 * Each hunk produced here is a self-contained unified diff snippet
 * (`--- a/...` + `+++ b/...` + one `@@ ... @@` block) so the Router can
 * `git apply` a single hunk directly (see ../router/README.md). The hunk id is
 * a stable content hash: sha256(sessionId|filePath|diffText).
 *
 * Zero dependencies — Node built-ins only.
 */

const crypto = require("node:crypto");

const sha256Hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/**
 * True when a diff payload is (or lacks) binary content. The AO daemon also
 * flags `binary: true` on the file listing / detail, but guard here too.
 */
function isBinaryDiffText(diff) {
  if (!diff || typeof diff !== "string") return true;
  const t = diff.trim();
  if (!t) return true;
  if (/^Binary files .* differ$/m.test(t)) return true;
  if (/^GIT binary patch$/m.test(t)) return true;
  // A text diff must contain at least one hunk header.
  if (!/^@@ /m.test(t)) return true;
  return false;
}

/**
 * Split a unified diff string (one file) into per-hunk blocks.
 * Returns [] if there are no hunks (e.g. pure binary diff).
 *
 * Each element: { block, diffText } where
 *   - block    = the raw `@@ ... @@` section (without file-level headers)
 *   - diffText = self-contained patch: file headers + the hunk block
 */
function splitUnifiedDiffIntoHunks(diffText) {
  if (!diffText || typeof diffText !== "string") return [];
  if (isBinaryDiffText(diffText)) return [];

  const lines = diffText.split(/\r?\n/);

  // --- collect file-level headers (everything before the first hunk) ---
  const headerLines = [];
  let modeLine = null; // "new file mode 100644" / "deleted file mode 100644"
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("@@")) break;
    if (/^(new file mode|deleted file mode) /.test(l)) modeLine = l;
    if (l.startsWith("--- ") || l.startsWith("+++ ")) headerLines.push(l);
  }

  // --- locate hunk start lines (@@ -l,c +l,c @@ ...) ---
  const starts = [];
  for (let j = i; j < lines.length; j++) {
    if (lines[j].startsWith("@@")) starts.push(j);
  }
  if (starts.length === 0) return [];

  // --- build each hunk ---
  const preamble = [...(modeLine ? [modeLine] : []), ...headerLines];
  const hunks = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    let block = lines.slice(from, to).join("\n");
    // keep exactly one trailing newline
    block = block.replace(/\s+$/, "");
    const diffText = [...preamble, block].join("\n") + "\n";
    hunks.push({ block, diffText });
  }
  return hunks;
}

/**
 * One-line human summary of a hunk: first added line if any, else the `@@`
 * header, else the first non-empty line. Truncated to a reasonable length.
 */
function summarizeHunk(hunkText) {
  const lines = hunkText.split(/\r?\n/);
  const truncate = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("+") && !t.startsWith("+++")) {
      const s = t.slice(1).trim();
      if (s) return truncate(s);
    }
  }
  const at = lines.find((l) => l.startsWith("@@"));
  if (at) return truncate(at.trim());
  const first = lines.find((l) => l.trim());
  return first ? truncate(first.trim()) : "";
}

/**
 * Stable hunk id: sha256(sessionId|filePath|diffText), per the frozen contract.
 * `diffText` here is the per-hunk diff snippet, so the id is content-derived
 * and identical across polls when the hunk is unchanged.
 */
function makeHunkId(sessionId, filePath, diffText) {
  return sha256Hex(`${sessionId}|${filePath}|${diffText}`);
}

/**
 * Build the full Hunk objects for one changed file.
 *
 * @param {object} arg
 * @param {string} arg.sessionId   AO session id
 * @param {string} arg.agentName   harness/display name
 * @param {string} arg.filePath    repo-relative path
 * @param {string} arg.diffText    full unified diff for the file (from AO daemon)
 * @returns {Array<{sessionId, agentName, filePath, hunkId, diffText, summary}>}
 */
function buildHunksForFile({ sessionId, agentName, filePath, diffText }) {
  const parts = splitUnifiedDiffIntoHunks(diffText);
  const seen = new Map(); // guard against identical hunks within one file
  const hunks = [];
  for (const p of parts) {
    let hunkId = makeHunkId(sessionId, filePath, p.diffText);
    const n = (seen.get(hunkId) || 0) + 1;
    seen.set(hunkId, n);
    if (n > 1) hunkId = `${hunkId}-${n}`; // keep unique: sha256(...)-NN
    hunks.push({
      sessionId,
      agentName,
      filePath,
      hunkId,
      diffText: p.diffText,
      summary: summarizeHunk(p.diffText),
    });
  }
  return hunks;
}

module.exports = {
  isBinaryDiffText,
  splitUnifiedDiffIntoHunks,
  summarizeHunk,
  makeHunkId,
  buildHunksForFile,
};

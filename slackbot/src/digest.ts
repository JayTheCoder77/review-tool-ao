/**
 * Digest builder — turns pending hunks from the Data Layer into:
 *   1. Slack Block Kit blocks (collapsible per-hunk: file, summary, diff snippet,
 *      Approve / Reject / Comment / Show-Hide-diff buttons), grouped per session.
 *   2. A plain-text rendering for the local (Slack-free) demo.
 *
 * The Slack markup here is produced by the same code paths the Bolt app posts;
 * the text/HTML renderers reuse the same grouping so the demo mirrors Slack.
 */

import type { KnownBlock } from "@slack/types";
import type { Hunk } from "./dataLayer.ts";

/** Slack `action_id` values — the hunk id travels in the button's `value`. */
export const ACTION_IDS = {
  approve: "swarmreview_hunk_approve",
  reject: "swarmreview_hunk_reject",
  comment: "swarmreview_hunk_comment",
  toggleDiff: "swarmreview_hunk_toggle_diff",
} as const;

/** Modal identifiers for the "Comment" (request revision) flow. */
export const COMMENT_VIEW_CALLBACK = "swarmreview_comment_modal";
export const COMMENT_INPUT_BLOCK = "comment_input";
export const COMMENT_INPUT_ACTION = "comment_text";

export interface SessionGroup {
  sessionId: string;
  agentName: string;
  hunks: Hunk[];
}

export function groupHunksBySession(hunks: Hunk[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const h of hunks) {
    let group = map.get(h.sessionId);
    if (!group) {
      group = { sessionId: h.sessionId, agentName: h.agentName, hunks: [] };
      map.set(h.sessionId, group);
    }
    group.hunks.push(h);
  }
  return [...map.values()];
}

export interface DigestBuildOptions {
  /** Render diffs expanded by default (used when no per-message state exists). */
  expandDiffsByDefault?: boolean;
  /** Hunk ids currently expanded in an existing digest message. */
  expandedHunkIds?: ReadonlySet<string>;
  /** Max chars for a diff snippet (clamped to Slack's 1500 char context limit). */
  diffMaxChars?: number;
}

/** Build a full Slack message body (header per session + per-hunk blocks). */
export function buildDigestBlocks(
  groups: SessionGroup[],
  opts: DigestBuildOptions = {},
): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const defaultExpanded = opts.expandDiffsByDefault ?? false;
  const diffMax = Math.min(opts.diffMaxChars ?? 1500, 1500);

  groups.forEach((group, gi) => {
    if (gi > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: truncate(`Session: ${group.sessionId}`, 150), emoji: false },
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Agent:* ${escapeSlack(group.agentName)} · *${group.hunks.length}* pending hunk(s)`,
        },
      ],
    });
    for (const hunk of group.hunks) {
      const expanded = opts.expandedHunkIds
        ? opts.expandedHunkIds.has(hunk.id)
        : defaultExpanded;
      blocks.push(...hunkBlocks(hunk, expanded, diffMax));
    }
  });
  return blocks;
}

function hunkBlocks(hunk: Hunk, expanded: boolean, diffMax: number): KnownBlock[] {
  const toggleLabel = expanded ? "Hide diff" : "Show diff";
  const blocks: KnownBlock[] = [
    {
      type: "section",
      block_id: `hunk_${hunk.id}_header`,
      text: {
        type: "mrkdwn",
        text: `*${escapeSlack(hunk.filePath)}*\n${escapeSlack(hunk.summary || "(no summary)")}`,
      },
    },
    {
      type: "actions",
      block_id: `hunk_${hunk.id}_actions`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: false },
          action_id: ACTION_IDS.approve,
          value: hunk.id,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: false },
          action_id: ACTION_IDS.reject,
          value: hunk.id,
          style: "danger",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Comment", emoji: false },
          action_id: ACTION_IDS.comment,
          value: hunk.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: toggleLabel, emoji: false },
          action_id: ACTION_IDS.toggleDiff,
          value: hunk.id,
        },
      ],
    },
  ];
  if (expanded) {
    blocks.push({
      type: "context",
      block_id: `hunk_${hunk.id}_diff`,
      elements: [{ type: "mrkdwn", text: codeBlock(sanitizeDiff(hunk.diffText, diffMax)) }],
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Markdown / text helpers
// ---------------------------------------------------------------------------

export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Make a diff snippet safe for a Slack mrkdwn code block and size-clamp it. */
export function sanitizeDiff(diff: string, maxChars: number): string {
  let s = diff;
  if (s.length > maxChars) {
    s = `${s.slice(0, maxChars)}\n\u2026 (truncated)`;
  }
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "'");
}

function codeBlock(sanitized: string): string {
  return `\`\`\`\n${sanitized}\n\`\`\``;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}\u2026`;
}

// ---------------------------------------------------------------------------
// Plain-text rendering (local demo, mirrors the Slack digest)
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
} as const;

export interface TextDigestOptions {
  color?: boolean;
  showDiffs?: boolean;
  diffMaxChars?: number;
}

export function renderTextDigest(groups: SessionGroup[], opts: TextDigestOptions = {}): string {
  const color = opts.color ?? false;
  const showDiffs = opts.showDiffs ?? true;
  const diffMax = opts.diffMaxChars ?? 1500;
  const paint = (code: keyof typeof ANSI, s: string) =>
    color ? `${ANSI[code]}${s}${ANSI.reset}` : s;

  const total = groups.reduce((n, g) => n + g.hunks.length, 0);
  const lines: string[] = [];
  lines.push(paint("bold", `SwarmReview — pending hunks digest (${total} pending)`));
  if (total === 0) {
    lines.push(paint("gray", "  No pending hunks. Inject some with: npm run demo:seed"));
    return lines.join("\n") + "\n";
  }

  groups.forEach((group, gi) => {
    lines.push("");
    lines.push(
      paint("cyan", `Session: ${group.sessionId}`) +
        paint("gray", `  [agent: ${group.agentName}]  ${group.hunks.length} pending`),
    );
    group.hunks.forEach((h, hi) => {
      lines.push(
        `  ${paint("magenta", `[${gi + 1}.${hi + 1}]`)} ${paint("bold", h.filePath)}`,
      );
      lines.push(`      summary: ${h.summary || "(none)"}`);
      lines.push(`      id:      ${h.id}`);
      lines.push(
        `      status:  ${h.status}   created: ${h.createdAt}   updated: ${h.updatedAt}`,
      );
      if (showDiffs) {
        const diff =
          h.diffText.length > diffMax
            ? `${h.diffText.slice(0, diffMax)}\n\u2026 (truncated)`
            : h.diffText;
        lines.push(`      diff:`);
        for (const line of diff.split("\n")) lines.push(`        ${line}`);
      }
      lines.push(paint("gray", "      actions: Approve | Reject | Comment (opens revise modal)"));
    });
  });
  return lines.join("\n") + "\n";
}

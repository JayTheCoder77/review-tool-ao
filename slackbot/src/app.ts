/**
 * Bolt app wiring for the SwarmReview digest bot.
 *
 * Responsibilities:
 *   - Poll the Data Layer for pending hunks and post one digest message per
 *     session (collapsible per-hunk blocks with Approve / Reject / Comment /
 *     Show-Hide-diff buttons).
 *   - Button clicks -> POST /decisions on the Data Layer. The Router is
 *     triggered by the Data Layer's `decision` event — this component never
 *     talks to AO.
 *   - Comment flow: opens a modal (views_open); on submit posts the decision
 *     with action "revise" + the collected comment.
 *   - After a decision (or a diff toggle), the digest message is rebuilt in
 *     place from fresh Data Layer state so decided hunks drop out.
 */

// @slack/bolt is CommonJS and its named exports are not statically detectable
// by Node's ESM interop, so we default-import and destructure at runtime.
import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Config } from "./config.ts";
import { DataLayer, type DecisionAction, type Hunk } from "./dataLayer.ts";
import {
  ACTION_IDS,
  COMMENT_INPUT_ACTION,
  COMMENT_INPUT_BLOCK,
  COMMENT_VIEW_CALLBACK,
  buildDigestBlocks,
  escapeSlack,
  groupHunksBySession,
  truncate,
  type SessionGroup,
} from "./digest.ts";

const { App, LogLevel } = bolt;

/**
 * Structural view of an action interaction payload — only the fields the
 * Slackbot reads. Bolt's native body type is a union; this keeps the handlers
 * simple while staying type-safe for the fields we actually use.
 */
interface AnyActionBody {
  actions?: Array<{ value?: string }>;
  channel?: { id?: string };
  message?: { ts?: string };
  trigger_id?: string;
}

export interface DigestPostInfo {
  channel: string;
  ts: string;
  sessionId: string;
  hunkCount: number;
}

export interface BuildAppOptions {
  /** Called after a new digest message is posted (useful for logging). */
  onDigestPosted?: (info: DigestPostInfo) => void;
  /** Called after a digest message is updated or deleted. */
  onDigestUpdated?: (sessionId: string, pendingCount: number) => void;
}

export interface SlackbotApp {
  app: InstanceType<typeof App>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Fetch pending hunks and post/refresh one digest message per session. */
  postDigests(): Promise<void>;
}

interface DigestMessage {
  channel: string;
  ts: string;
}

export function buildApp(config: Config, data: DataLayer, opts: BuildAppOptions = {}): SlackbotApp {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken || undefined,
    socketMode: config.socketMode,
    signingSecret: config.signingSecret || undefined,
    port: config.port,
    logLevel: LogLevel.INFO,
  });

  /** sessionId -> latest digest message for that session. */
  const sessionMessages = new Map<string, DigestMessage>();
  /** `channel|ts` -> sessionId, so button clicks can find their session. */
  const messageToSession = new Map<string, string>();
  /** `channel|ts` -> set of hunk ids currently expanded in that message. */
  const expandedByMessage = new Map<string, Set<string>>();

  const messageKey = (channel: string, ts: string) => `${channel}|${ts}`;

  // -------------------------------------------------------------------------
  // Digest posting / refresh
  // -------------------------------------------------------------------------

  async function pendingForSession(sessionId: string): Promise<Hunk[]> {
    return data.listHunks({ status: "pending", sessionId });
  }

  function buildBlocksFor(group: SessionGroup, expanded: ReadonlySet<string> | undefined) {
    return buildDigestBlocks([group], {
      expandDiffsByDefault: config.expandDiffsByDefault,
      expandedHunkIds: expanded,
      diffMaxChars: config.diffMaxChars,
    });
  }

  async function postDigests(): Promise<void> {
    if (!config.slackChannel) {
      console.warn(
        "[slackbot] SLACK_CHANNEL not set — cannot post digests. " +
          "Set SLACK_BOT_TOKEN + SLACK_CHANNEL for the real Slack path, or use `npm run demo` locally.",
      );
      return;
    }
    const hunks = await data.listHunks({ status: "pending" });
    const groups = groupHunksBySession(hunks);
    for (const group of groups) {
      await postOrUpdateSession(group);
    }
    // Remove digests for sessions that no longer have pending hunks.
    for (const sessionId of [...sessionMessages.keys()]) {
      if (!groups.some((g) => g.sessionId === sessionId)) {
        await removeSessionMessage(sessionId);
      }
    }
  }

  async function postOrUpdateSession(group: SessionGroup): Promise<void> {
    const existing = sessionMessages.get(group.sessionId);
    const key = existing ? messageKey(existing.channel, existing.ts) : undefined;
    const blocks = buildBlocksFor(group, key ? expandedByMessage.get(key) : undefined);
    const text = `${group.sessionId}: ${group.hunks.length} pending hunk(s) — SwarmReview`;

    if (existing) {
      try {
        await app.client.chat.update({ channel: existing.channel, ts: existing.ts, blocks, text });
      } catch (e) {
        console.error(`[slackbot] chat.update failed for ${group.sessionId}:`, message(e));
      }
      opts.onDigestUpdated?.(group.sessionId, group.hunks.length);
      return;
    }

    const res = await app.client.chat.postMessage({
      channel: config.slackChannel,
      blocks,
      text,
      unfurl_links: false,
    });
    const ts = res.ts ?? res.message?.ts;
    if (!ts) {
      throw new Error(`chat.postMessage returned no ts for ${group.sessionId}`);
    }
    const msg: DigestMessage = { channel: config.slackChannel, ts };
    sessionMessages.set(group.sessionId, msg);
    messageToSession.set(messageKey(msg.channel, msg.ts), group.sessionId);
    opts.onDigestPosted?.({
      channel: msg.channel,
      ts: msg.ts,
      sessionId: group.sessionId,
      hunkCount: group.hunks.length,
    });
  }

  async function removeSessionMessage(sessionId: string): Promise<void> {
    const msg = sessionMessages.get(sessionId);
    if (!msg) return;
    sessionMessages.delete(sessionId);
    messageToSession.delete(messageKey(msg.channel, msg.ts));
    expandedByMessage.delete(messageKey(msg.channel, msg.ts));
    try {
      await app.client.chat.delete({ channel: msg.channel, ts: msg.ts });
    } catch (e) {
      // Message may already be gone; not fatal.
      console.debug(`[slackbot] chat.delete skipped for ${sessionId}:`, message(e));
    }
  }

  /** Rebuild the digest message for a session from fresh pending hunks. */
  async function refreshSession(sessionId: string): Promise<void> {
    const msg = sessionMessages.get(sessionId);
    if (!msg) return;
    const hunks = await pendingForSession(sessionId);
    if (hunks.length === 0) {
      await removeSessionMessage(sessionId);
      return;
    }
    const key = messageKey(msg.channel, msg.ts);
    const blocks = buildBlocksFor(
      { sessionId, agentName: hunks[0].agentName, hunks },
      expandedByMessage.get(key),
    );
    try {
      await app.client.chat.update({
        channel: msg.channel,
        ts: msg.ts,
        blocks,
        text: `${sessionId}: ${hunks.length} pending hunk(s) — SwarmReview`,
      });
    } catch (e) {
      console.error(`[slackbot] chat.update failed for ${sessionId}:`, message(e));
    }
    opts.onDigestUpdated?.(sessionId, hunks.length);
  }

  // -------------------------------------------------------------------------
  // Interaction helpers
  // -------------------------------------------------------------------------

  function actionValue(body: AnyActionBody): string | undefined {
    return body.actions?.[0]?.value;
  }

  function channelAndTs(body: AnyActionBody): { channel?: string; ts?: string } {
    return { channel: body.channel?.id, ts: body.message?.ts };
  }

  async function sessionForMessage(body: AnyActionBody): Promise<string | undefined> {
    const { channel, ts } = channelAndTs(body);
    if (!channel || !ts) return undefined;
    const key = messageKey(channel, ts);
    let sessionId = messageToSession.get(key);
    if (!sessionId) {
      // Fall back: the hunk itself knows its session.
      const hunkId = actionValue(body);
      if (hunkId) {
        try {
          sessionId = (await data.getHunk(hunkId)).sessionId;
        } catch {
          sessionId = undefined;
        }
      }
    }
    return sessionId;
  }

  async function recordDecision(
    input: { hunkId: string; action: DecisionAction; comment?: string },
  ): Promise<void> {
    const result = await data.postDecision(input);
    console.log(
      `[slackbot] decision ${input.action} for ${input.hunkId} -> hunk status ${result.hunk.status}`,
    );
  }

  async function notifyError(
    client: WebClient,
    body: AnyActionBody,
    text: string,
  ): Promise<void> {
    const { channel, ts } = channelAndTs(body);
    if (!channel) return;
    try {
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: truncate(`SwarmReview: ${text}`, 2900),
      });
    } catch (e) {
      console.error("[slackbot] failed to notify:", e);
    }
  }

  async function handleDecisionAction(
    body: AnyActionBody,
    client: WebClient,
    action: DecisionAction,
  ): Promise<void> {
    const hunkId = actionValue(body);
    if (!hunkId) return;
    try {
      await recordDecision({ hunkId, action });
    } catch (e) {
      await notifyError(client, body, message(e));
      return;
    }
    const sessionId = await sessionForMessage(body);
    if (sessionId) await refreshSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  app.action(ACTION_IDS.approve, async ({ ack, body, client }) => {
    await ack();
    await handleDecisionAction(body as AnyActionBody, client, "approve");
  });

  app.action(ACTION_IDS.reject, async ({ ack, body, client }) => {
    await ack();
    await handleDecisionAction(body as AnyActionBody, client, "reject");
  });

  app.action(ACTION_IDS.toggleDiff, async ({ ack, body, client }) => {
    await ack();
    const actionBody = body as AnyActionBody;
    const hunkId = actionValue(actionBody);
    const { channel, ts } = channelAndTs(actionBody);
    if (!hunkId || !channel || !ts) return;
    const key = messageKey(channel, ts);
    let expanded = expandedByMessage.get(key);
    if (!expanded) {
      expanded = new Set(config.expandDiffsByDefault ? [hunkId] : []);
      expandedByMessage.set(key, expanded);
    }
    if (expanded.has(hunkId)) expanded.delete(hunkId);
    else expanded.add(hunkId);
    const sessionId = messageToSession.get(key);
    if (sessionId) await refreshSession(sessionId);
  });

  app.action(ACTION_IDS.comment, async ({ ack, body, client }) => {
    await ack();
    const actionBody = body as AnyActionBody;
    const hunkId = actionValue(actionBody);
    if (!hunkId || !actionBody.trigger_id) return;
    let hunkSummary = "";
    try {
      const hunk = await data.getHunk(hunkId);
      hunkSummary = `*${escapeSlack(hunk.filePath)}*\n${escapeSlack(hunk.summary || "")}`;
    } catch {
      // Modal still opens; context just shows a generic line.
      hunkSummary = `hunk \`${hunkId}\``;
    }
    try {
      await client.views.open({
        trigger_id: actionBody.trigger_id,
        view: {
          type: "modal",
          callback_id: COMMENT_VIEW_CALLBACK,
          private_metadata: hunkId,
          title: { type: "plain_text", text: "Request revision", emoji: false },
          submit: { type: "plain_text", text: "Send", emoji: false },
          close: { type: "plain_text", text: "Cancel", emoji: false },
          blocks: [
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: truncate(hunkSummary, 1900) }],
            },
            {
              type: "input",
              block_id: COMMENT_INPUT_BLOCK,
              element: {
                type: "plain_text_input",
                action_id: COMMENT_INPUT_ACTION,
                multiline: true,
                placeholder: {
                  type: "plain_text",
                  text: "What should the agent change?",
                },
              },
              label: { type: "plain_text", text: "Comment for the agent", emoji: false },
            },
          ],
        },
      });
    } catch (e) {
      await notifyError(client, actionBody, `could not open modal: ${message(e)}`);
    }
  });

  app.view(COMMENT_VIEW_CALLBACK, async ({ ack, view, client }) => {
    await ack();
    const hunkId = view.private_metadata ?? "";
    const values = (view.state.values as Record<
      string,
      Record<string, { value?: string }>
    >) ?? {};
    const comment = (values[COMMENT_INPUT_BLOCK]?.[COMMENT_INPUT_ACTION]?.value ?? "").trim();
    if (!hunkId || !comment) {
      console.warn("[slackbot] comment modal submitted without hunkId or comment");
      return;
    }
    try {
      await recordDecision({ hunkId, action: "revise", comment });
    } catch (e) {
      console.error("[slackbot] revise failed:", message(e));
      return;
    }
    // View submissions don't carry the digest message ts; find the session via
    // the hunk and refresh its digest message so the decided hunk drops out.
    let sessionId: string | undefined;
    try {
      sessionId = (await data.getHunk(hunkId)).sessionId;
    } catch {
      sessionId = undefined;
    }
    if (sessionId) await refreshSession(sessionId);
  });

  // -------------------------------------------------------------------------

  return {
    app,
    async start() {
      await app.start();
    },
    async stop() {
      await app.stop();
    },
    postDigests,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

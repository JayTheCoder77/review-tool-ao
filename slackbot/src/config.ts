/**
 * Environment-driven configuration for the Slackbot component.
 *
 * The Slackbot talks ONLY to the Data Layer API (default http://127.0.0.1:4821)
 * and to Slack. It never calls the AO daemon.
 */

export interface Config {
  /** Data Layer base URL (SWARMREVIEW_DATA_URL, default http://127.0.0.1:4821). */
  dataUrl: string;
  /** Slack bot token (xoxb-...) used by Bolt + the Web client. */
  slackBotToken: string;
  /** Slack app-level token (xapp-...) used for Socket Mode. */
  slackAppToken: string;
  /** Channel to post digests to (SLACK_CHANNEL). */
  slackChannel: string;
  /** Use Socket Mode when an app token is present (SWARMREVIEW_SOCKET_MODE, default true). */
  socketMode: boolean;
  /** Signing secret for HTTP-mode Bolt app (SLACK_SIGNING_SECRET). */
  signingSecret: string;
  /** Port for HTTP-mode Bolt app (SWARMREVIEW_HTTP_PORT, default 3000). */
  port: number;
  /** Poll interval for new pending hunks (SWARMREVIEW_POLL_INTERVAL_MS, default 10000). */
  pollIntervalMs: number;
  /** Render diff snippets expanded by default (SWARMREVIEW_EXPAND_DIFFS=1). */
  expandDiffsByDefault: boolean;
  /** Truncate diff snippets to this many chars (SWARMREVIEW_DIFF_MAX_CHARS, default 1500). */
  diffMaxChars: number;
  /** Port for the local demo HTTP server (SWARMREVIEW_DEMO_PORT, default 4822). */
  demoPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appToken = env.SLACK_APP_TOKEN ?? "";
  const socketMode =
    appToken.length > 0 && (env.SWARMREVIEW_SOCKET_MODE ?? "true") !== "false";
  return {
    dataUrl: env.SWARMREVIEW_DATA_URL ?? "http://127.0.0.1:4821",
    slackBotToken: env.SLACK_BOT_TOKEN ?? "",
    slackAppToken: appToken,
    slackChannel: env.SLACK_CHANNEL ?? "",
    socketMode,
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",
    port: Number(env.SWARMREVIEW_HTTP_PORT ?? 3000),
    pollIntervalMs: Number(env.SWARMREVIEW_POLL_INTERVAL_MS ?? 10_000),
    expandDiffsByDefault: (env.SWARMREVIEW_EXPAND_DIFFS ?? "0") === "1",
    diffMaxChars: Number(env.SWARMREVIEW_DIFF_MAX_CHARS ?? 1500),
    demoPort: Number(env.SWARMREVIEW_DEMO_PORT ?? 4822),
  };
}

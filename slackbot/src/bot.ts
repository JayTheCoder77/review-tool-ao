#!/usr/bin/env node
/**
 * Slackbot entrypoint — real Slack path.
 *
 * Requires env:
 *   SLACK_BOT_TOKEN   (xoxb-...)
 *   SLACK_APP_TOKEN   (xapp-..., enables Socket Mode; otherwise HTTP mode with
 *                      SLACK_SIGNING_SECRET + SWARMREVIEW_HTTP_PORT)
 *   SLACK_CHANNEL     (channel id or name to post digests to)
 *   SWARMREVIEW_DATA_URL   (default http://127.0.0.1:4821)
 *
 * With no credentials, `npm run demo` provides the Slack-free local path.
 */

import { loadConfig } from "./config.ts";
import { DataLayer } from "./dataLayer.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();

if (!config.slackBotToken) {
  console.error(
    "[slackbot] SLACK_BOT_TOKEN is not set. This sandbox has no Slack workspace " +
      "credentials, so run the local demo instead:\n" +
      "    cd slackbot && npm run demo:seed && npm run demo:digest && npm run demo:serve\n" +
      "See slackbot/README.md for the real-Slack setup.",
  );
  process.exit(1);
}

const data = new DataLayer(config.dataUrl);
const bot = buildApp(config, data, {
  onDigestPosted: (info) =>
    console.log(
      `[slackbot] digest posted: ${info.sessionId} (${info.hunkCount} hunks) -> ` +
        `${info.channel} ts=${info.ts}`,
    ),
  onDigestUpdated: (sessionId, pendingCount) =>
    console.log(`[slackbot] digest updated: ${sessionId} (${pendingCount} pending)`),
});

await bot.start();
console.log(`[slackbot] Bolt app started (socketMode=${config.socketMode}, data=${config.dataUrl})`);

// Initial digest, then poll for new pending hunks.
await bot.postDigests();
const timer = setInterval(() => {
  bot.postDigests().catch((e) => console.error("[slackbot] poll failed:", e));
}, config.pollIntervalMs);
timer.unref();

const shutdown = async () => {
  clearInterval(timer);
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

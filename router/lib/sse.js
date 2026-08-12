"use strict";
/**
 * Minimal Server-Sent Events (SSE) consumer using node:http.
 * The Data Layer exposes `GET /events` which streams `event: decision` /
 * `event: hunk` frames. We only care about `decision` frames, which carry
 * `data: {"decision": Decision, "hunk": Hunk}`.
 *
 * The consumer does NOT auto-reconnect; the caller decides when to re-subscribe
 * (see router.js). A `retry: 3000` line is emitted by the server but we manage
 * our own reconnect policy.
 */
const http = require("node:http");

/**
 * @param {object} opts
 * @param {string} opts.baseUrl     e.g. "http://127.0.0.1:4821"
 * @param {string} opts.types       event types to ask for, e.g. "decision" (server ignores it, but contract-compliant)
 * @param {(d: any) => void} opts.onDecision  called with the Decision object for every `event: decision` frame
 * @param {(err: Error) => void} opts.onError  connection-level error
 * @param {() => void} opts.onClose  stream ended cleanly
 * @param {() => void} opts.onOpen   HTTP 200 headers received (first flush)
 * @returns {{ close: () => void }}
 */
function subscribeDecisionStream({ baseUrl, types = "decision", onDecision, onError, onClose, onOpen }) {
  const url = `${baseUrl}/events?types=${encodeURIComponent(types)}`;
  let closed = false;
  let req;

  function close() {
    closed = true;
    if (req && !req.destroyed) req.destroy();
  }

  const connect = () => {
    if (closed) return;
    req = http.get(url, { headers: { Accept: "text/event-stream" } }, (res) => {
      if (closed) {
        res.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        onError && onError(new Error(`SSE ${url} returned HTTP ${res.statusCode}`));
        return;
      }
      onOpen && onOpen();
      let buffer = "";
      let currentEvent = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const rawLine of block.split("\n")) {
            const line = rawLine.replace(/\r$/, "");
            if (line.startsWith(":")) continue; // keepalive comment
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (currentEvent === "decision" && data) {
                try {
                  const payload = JSON.parse(data);
                  if (payload && payload.decision) onDecision && onDecision(payload.decision);
                } catch {
                  // malformed frame — skip; poll fallback covers gaps
                }
              }
              currentEvent = "";
            }
          }
        }
      });
      res.on("error", (e) => {
        if (!closed) onError && onError(e);
      });
      res.on("end", () => {
        if (!closed) onClose && onClose();
      });
    });
    req.on("error", (e) => {
      if (!closed) onError && onError(e);
    });
  };

  connect();
  return { close };
}

module.exports = { subscribeDecisionStream };

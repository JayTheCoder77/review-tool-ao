"use strict";
/**
 * Zero-dependency HTTP/JSON helpers (built on the global fetch, Node >= 22).
 * Used by the Data Layer client and the AO daemon client.
 */

const DEFAULT_TIMEOUT_MS = 15000;

/** GET a URL and parse the JSON body. Throws HttpError with status + body on non-2xx. */
async function getJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return requestJson("GET", url, undefined, { timeoutMs });
}

/** POST a JSON body to a URL and parse the JSON response. Throws HttpError on non-2xx. */
async function postJson(url, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return requestJson("POST", url, body, { timeoutMs });
}

async function requestJson(method, url, body, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON body (e.g. plain-text error page) — keep it as raw
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new HttpError(`${method} ${url} -> ${res.status}`, res.status, parsed, text);
    }
    return parsed;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new HttpError(`${method} ${url} timed out after ${timeoutMs}ms`, 0, null, "");
    }
    if (e instanceof HttpError) throw e;
    throw new HttpError(`${method} ${url} failed: ${e.message}`, 0, null, "");
  } finally {
    clearTimeout(timer);
  }
}

class HttpError extends Error {
  constructor(message, status, body, rawText) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.rawText = rawText;
  }
}

module.exports = { getJson, postJson, HttpError };

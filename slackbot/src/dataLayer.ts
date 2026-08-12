/**
 * Typed client for the SwarmReview Data Layer.
 *
 * Implements exactly the endpoints the Slackbot is allowed to use (frozen
 * contract in db/schema.md):
 *   - GET /hunks?status=pending   (read pending hunks)
 *   - GET /hunks/:id              (read a single hunk, e.g. for the comment modal)
 *   - POST /decisions             (record approve / reject / revise)
 *   - GET /decisions              (verification / demo)
 *
 * The Slackbot never talks to the AO daemon — the Router is triggered by the
 * Data Layer's `decision` SSE event, not by us.
 */

export type HunkStatus = "pending" | "approved" | "rejected" | "needs_revision";
export type DecisionAction = "approve" | "reject" | "revise";

export interface Hunk {
  id: string;
  sessionId: string;
  agentName: string;
  filePath: string;
  diffText: string;
  summary: string;
  status: HunkStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  hunkId: string;
  action: DecisionAction;
  comment?: string;
  decidedAt: string;
}

export interface DecisionInput {
  hunkId: string;
  action: DecisionAction;
  comment?: string;
}

export interface PostDecisionResult {
  decision: Decision;
  hunk: Hunk;
}

export interface ListHunksParams {
  status?: HunkStatus;
  sessionId?: string;
}

export interface PostHunkInput {
  /** Optional client-supplied stable id. */
  id?: string;
  sessionId: string;
  agentName?: string;
  filePath: string;
  diffText: string;
  summary?: string;
}

export interface PostHunkResult {
  hunk: Hunk;
  /** true when a new hunk was created, false when the id already existed. */
  created: boolean;
}

export interface ListDecisionsParams {
  hunkId?: string;
  action?: DecisionAction;
}

/** Error raised when the Data Layer returns a non-2xx response. */
export class DataLayerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DataLayerError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class DataLayer {
  readonly baseUrl: string;

  constructor(baseUrl = process.env.SWARMREVIEW_DATA_URL ?? "http://127.0.0.1:4821") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async listHunks(params: ListHunksParams = {}): Promise<Hunk[]> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.sessionId) q.set("sessionId", params.sessionId);
    const qs = q.toString();
    const body = await this.request("GET", qs ? `/hunks?${qs}` : "/hunks");
    return (body as { hunks: Hunk[] }).hunks;
  }

  /** Publish a hunk (used by the demo seeder; the Listener owns the real feed). */
  async postHunk(input: PostHunkInput): Promise<PostHunkResult> {
    const body = await this.request("POST", "/hunks", input);
    return body as PostHunkResult;
  }

  async getHunk(id: string): Promise<Hunk> {
    const body = await this.request("GET", `/hunks/${encodeURIComponent(id)}`);
    return (body as { hunk: Hunk }).hunk;
  }

  async postDecision(input: DecisionInput): Promise<PostDecisionResult> {
    const body = await this.request("POST", "/decisions", input);
    return body as PostDecisionResult;
  }

  async listDecisions(params: ListDecisionsParams = {}): Promise<Decision[]> {
    const q = new URLSearchParams();
    if (params.hunkId) q.set("hunkId", params.hunkId);
    if (params.action) q.set("action", params.action);
    const qs = q.toString();
    const body = await this.request("GET", qs ? `/decisions?${qs}` : "/decisions");
    return (body as { decisions: Decision[] }).decisions;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      });
    } catch (cause) {
      throw new Error(
        `Data Layer unreachable at ${this.baseUrl} — is it running? (cd db && node server.js)`,
        { cause },
      );
    }
    let body: unknown = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok) {
      const e = (body as ErrorBody).error;
      throw new DataLayerError(
        res.status,
        e?.code ?? `HTTP_${res.status}`,
        e?.message ?? `${method} ${path} failed (${res.status})`,
      );
    }
    return body as T;
  }
}

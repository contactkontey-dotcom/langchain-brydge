import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { BrydgeError } from "./errors.js";
import { supervisedActions, type MessagesLike, type SupervisedAction } from "./record.js";
import type { Facts, Headroom, Outcome, Supervision, Verification } from "./types.js";
import { VERSION } from "./version.js";

/** BRYDGE's hosted service. Set `BRYDGE_URL` or pass `baseUrl` to use another. */
export const DEFAULT_BASE_URL = "https://www.brydge-ai.com";

const KEY_PREFIX = "brydge_sk_";
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface BrydgeClientOptions {
  /** Your BRYDGE API key. Defaults to the `BRYDGE_API_KEY` environment variable. */
  apiKey?: string;
  /** Where BRYDGE runs. Defaults to `BRYDGE_URL`, then to BRYDGE's hosted service. */
  baseUrl?: string;
  /** How long to wait for BRYDGE before giving up, in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
}

export interface SuperviseInput {
  /** The agent asking, as BRYDGE knows it, such as `agent:refund-ops`. */
  actor: string;
  /** The kind of work, such as `refund`. Must have a declared value in BRYDGE. */
  action: string;
  /** What the work acts on: the payment, order or ticket. */
  target: string;
  /** What BRYDGE's mandates judge the action by. */
  facts?: Facts;
  /** Stable for one intended action. A retry with the same key gets the same answer. */
  idempotencyKey: string;
}

export interface RequestOptions {
  /** Cancels the request to BRYDGE. */
  signal?: AbortSignal;
}

/** A supervised action together with what BRYDGE found about it. */
export type WorkCheck = SupervisedAction & Verification;

/**
 * BRYDGE's API: ask before acting, report what happened, and check whether it
 * did happen.
 *
 * ```ts
 * const brydge = new BrydgeClient(); // reads BRYDGE_API_KEY
 * const finding = await brydge.verify(authorization);
 * finding.state; // "VERIFIED" | "FAILED" | "MISMATCH" | "UNKNOWN" | "PENDING"
 * ```
 */
export class BrydgeClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: BrydgeClientOptions = {}) {
    const apiKey = (options.apiKey ?? getEnvironmentVariable("BRYDGE_API_KEY") ?? "").trim();
    if (!apiKey) {
      throw new BrydgeError(
        "No BRYDGE API key. Set BRYDGE_API_KEY, or pass { apiKey }. Issue a key in BRYDGE on the Connect page.",
      );
    }
    if (!apiKey.startsWith(KEY_PREFIX)) {
      throw new BrydgeError(`That is not a BRYDGE API key. BRYDGE keys start with ${KEY_PREFIX}.`);
    }
    this.#apiKey = apiKey;
    /* An empty setting, like `BRYDGE_URL=` in a .env file, means unset. */
    this.baseUrl = baseUrlFrom(options.baseUrl || getEnvironmentVariable("BRYDGE_URL") || DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new BrydgeError("timeoutMs must be a positive number of milliseconds.");
    }
    const custom = options.fetch;
    this.#fetch = (input, init) => (custom ?? fetch)(input, init);
  }

  /**
   * Ask BRYDGE whether the agent may do this, before it does it.
   *
   * `ALLOWED` carries the authorization to cite at the destination.
   * `ESCALATED` means a person decides, and the work must not be done yet.
   */
  async supervise(input: SuperviseInput, options: RequestOptions = {}): Promise<Supervision> {
    const answer = await this.#request("POST", "/api/supervise", options, {
      actor: required(input.actor, "actor"),
      action: required(input.action, "action"),
      target: required(input.target, "target"),
      facts: input.facts ?? {},
      idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
    });
    if (typeof answer.id !== "string" || (answer.decision !== "ALLOWED" && answer.decision !== "ESCALATED")) {
      throw new BrydgeError("BRYDGE answered without a decision. Nothing was authorised.");
    }
    return {
      id: answer.id,
      decision: answer.decision,
      mandateId: typeof answer.mandateId === "string" ? answer.mandateId : null,
      because: typeof answer.because === "string" ? answer.because : "",
      checked: Array.isArray(answer.checked) ? (answer.checked as Supervision["checked"]) : [],
      unobserved: Array.isArray(answer.unobserved) ? answer.unobserved.filter((f): f is string => typeof f === "string") : [],
      replayed: answer.replayed === true,
    };
  }

  /**
   * Tell BRYDGE what the agent says happened. BRYDGE keeps the report beside
   * what it finds in the records; the report never changes the finding.
   */
  async report(
    authorization: string,
    outcome: Outcome,
    options: RequestOptions & { said?: string; by?: string } = {},
  ): Promise<void> {
    await this.#request("POST", `${actionPath(authorization)}/outcome`, options, {
      verdict: outcome,
      ...(options.said === undefined ? {} : { said: options.said }),
      ...(options.by === undefined ? {} : { by: options.by }),
    });
  }

  /**
   * Did it actually happen? BRYDGE reads the destination's own records now,
   * with its own credential, and compares them with what it authorised.
   *
   * Each call that finds something new is a billed check. Asking again when
   * nothing has changed returns the same finding and is not billed.
   */
  async verify(authorization: string, options: RequestOptions = {}): Promise<Verification> {
    return verificationFrom(await this.#request("POST", `${actionPath(authorization)}/verify`, options), authorization);
  }

  /**
   * What BRYDGE has found so far, without reading the records again. Free.
   * BRYDGE checks every action on its own once the destination's reporting
   * window has passed; until then this says `PENDING`.
   */
  async finding(authorization: string, options: RequestOptions = {}): Promise<Verification> {
    return verificationFrom(await this.#request("GET", `${actionPath(authorization)}/verify`, options), authorization);
  }

  /** How much this agent may do without a person in any 24 hours, and why. */
  async headroom(actor: string, action: string, options: RequestOptions = {}): Promise<Headroom> {
    const query = new URLSearchParams({ actor: required(actor, "actor"), action: required(action, "action") });
    return (await this.#request("GET", `/api/headroom?${query}`, options)) as unknown as Headroom;
  }

  /**
   * Check every action the agent carried out in these messages.
   *
   * Pass the messages an agent run returns, or the run's whole result. Calls
   * BRYDGE sent to a person are skipped: nothing was done, so there is nothing
   * to find.
   */
  async verifyWork(
    input: MessagesLike,
    options: RequestOptions & { toolCallId?: string } = {},
  ): Promise<WorkCheck[]> {
    const actions = supervisedActions(input).filter(
      (a) => a.carriedOut && (options.toolCallId === undefined || a.toolCallId === options.toolCallId),
    );
    const checks: WorkCheck[] = [];
    /* One at a time: a run rarely holds more than a handful, and a burst would
     * spend the rate limit other calls need. */
    for (const action of actions) {
      checks.push({ ...action, ...(await this.verify(action.authorization, options)) });
    }
    return checks;
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    options: RequestOptions,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      "user-agent": `brydge-langchain/${VERSION}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      options.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new BrydgeError(
        timeout.aborted
          ? `BRYDGE did not answer within ${this.timeoutMs} ms. It may still have acted on the request; ` +
            "sending the same request again is safe and returns BRYDGE's answer."
          : `BRYDGE could not be reached: ${cause instanceof Error ? cause.message : String(cause)}.`,
        { cause },
      );
    }

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) throw errorFrom(response, json, text);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new BrydgeError(`BRYDGE answered ${response.status} with something that is not a JSON object.`, {
        status: response.status,
      });
    }
    return json as Record<string, unknown>;
  }
}

function baseUrlFrom(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BrydgeError(`BRYDGE_URL is not a URL: ${raw}`);
  }
  /* The key travels on every request, so never in the clear, except to this machine. */
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new BrydgeError("BRYDGE_URL must use https. Plain http is accepted only for localhost.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function actionPath(authorization: string): string {
  return `/api/supervise/${encodeURIComponent(required(authorization, "authorization"))}`;
}

function required(value: string, name: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new BrydgeError(`BRYDGE needs a ${name}.`);
  return v;
}

/** Both shapes BRYDGE uses for a finding, including "not checked yet", as one. */
function verificationFrom(raw: Record<string, unknown>, authorization: string): Verification {
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const state = raw.state;
  if (state !== "PENDING" && state !== "VERIFIED" && state !== "FAILED" && state !== "MISMATCH" && state !== "UNKNOWN") {
    throw new BrydgeError("BRYDGE answered without a finding.");
  }
  return {
    authorization: text(raw.supervisionId) ?? authorization,
    state,
    reason: text(raw.reason) as Verification["reason"],
    because: text(raw.because) ?? "",
    externalRef: text(raw.externalRef),
    claimed: text(raw.claimed) as Verification["claimed"],
    agentAgreed: typeof raw.agentAgreed === "boolean" ? raw.agentAgreed : null,
    checkedAt: text(raw.checkedAt),
    replayed: raw.replayed === true,
  };
}

function errorFrom(response: Response, json: unknown, text: string): BrydgeError {
  const body = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const said = typeof body.error === "string" ? body.error : text.slice(0, 300) || response.statusText;
  const detail = Array.isArray(body.detail) ? ` (${body.detail.filter((d) => typeof d === "string").join("; ")})` : "";
  const header = Number(response.headers.get("retry-after"));
  const retryAfterSeconds =
    typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : header > 0 ? header : null;
  return new BrydgeError(`BRYDGE answered ${response.status}: ${said}${detail}`, {
    status: response.status,
    reason: typeof body.reason === "string" ? body.reason : null,
    retryAfterSeconds,
  });
}

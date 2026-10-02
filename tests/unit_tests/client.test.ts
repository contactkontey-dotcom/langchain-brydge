import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrydgeClient, BrydgeError, DEFAULT_BASE_URL, VERSION } from "../../src/index.js";
import { fakeBrydge } from "./fake-brydge.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEY = "brydge_sk_unit_test_key";

describe("a client needs a real key and a safe address", () => {
  it("refuses to start without a key, and says where to get one", () => {
    vi.stubEnv("BRYDGE_API_KEY", "");
    expect(() => new BrydgeClient()).toThrow(/BRYDGE_API_KEY.*Connect page/);
  });

  it("refuses something that is not a BRYDGE key", () => {
    expect(() => new BrydgeClient({ apiKey: "sk_live_123" })).toThrow(/start with brydge_sk_/);
  });

  it("reads the key and the address from the environment", () => {
    vi.stubEnv("BRYDGE_API_KEY", KEY);
    vi.stubEnv("BRYDGE_URL", "https://brydge.example.com/");
    expect(new BrydgeClient().baseUrl).toBe("https://brydge.example.com");
  });

  it("uses BRYDGE's hosted service when no address is given", () => {
    vi.stubEnv("BRYDGE_URL", "");
    expect(new BrydgeClient({ apiKey: KEY, baseUrl: undefined }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("never sends the key over plain http, except to this machine", () => {
    expect(() => new BrydgeClient({ apiKey: KEY, baseUrl: "http://brydge.example.com" })).toThrow(/https/);
    expect(new BrydgeClient({ apiKey: KEY, baseUrl: "http://localhost:3000" }).baseUrl).toBe("http://localhost:3000");
    expect(new BrydgeClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:3000" }).baseUrl).toBe("http://127.0.0.1:3000");
  });

  it("refuses a timeout that could never be met", () => {
    expect(() => new BrydgeClient({ apiKey: KEY, timeoutMs: 0 })).toThrow(/positive number/);
    expect(() => new BrydgeClient({ apiKey: KEY, timeoutMs: Number.NaN })).toThrow(/positive number/);
  });

  it("keeps the key off the object, so logging a client does not leak it", () => {
    const client = new BrydgeClient({ apiKey: KEY, baseUrl: "https://brydge.test" });
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(Object.values(client)).not.toContain(KEY);
  });
});

describe("asking before acting", () => {
  it("sends what the API expects, with the key as a bearer token", async () => {
    const brydge = fakeBrydge();
    await brydge.client.supervise({
      actor: " agent:refund-ops ",
      action: "refund",
      target: "pi_123",
      facts: { amount: 4200 },
      idempotencyKey: "refund:pi_123",
    });
    const [asked] = brydge.asked();
    expect(asked!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(asked!.headers["content-type"]).toBe("application/json");
    expect(asked!.headers["user-agent"]).toBe(`brydge-langchain/${VERSION}`);
    expect(asked!.body).toEqual({
      actor: "agent:refund-ops",
      action: "refund",
      target: "pi_123",
      facts: { amount: 4200 },
      idempotencyKey: "refund:pi_123",
    });
  });

  it("returns BRYDGE's decision as BRYDGE gave it", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const answer = await brydge.client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" });
    expect(answer).toMatchObject({ id: "sup_1", decision: "ESCALATED", mandateId: null, unobserved: ["amount"], replayed: false });
  });

  it("carries a person's answer, and what to do while there is none", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const ask = () => brydge.client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" });
    expect(await ask()).toMatchObject({ decision: "ESCALATED", settled: null, next: expect.stringMatching(/same idempotency key/) });
    brydge.settle("sup_1", "ALLOWED");
    expect(await ask()).toMatchObject({ id: "sup_1", decision: "ALLOWED", settled: "ALLOWED", next: null, replayed: true });
  });

  it("reads an answer from a server that knows nothing of settlements as unanswered", async () => {
    const brydge = fakeBrydge({
      refuse: {
        "POST /api/supervise": () =>
          Response.json({ id: "sup_9", decision: "ESCALATED", because: "a person decides", settled: "MAYBE", next: 7 }),
      },
    });
    const answer = await brydge.client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" });
    expect(answer).toMatchObject({ id: "sup_9", decision: "ESCALATED", settled: null, next: null });
  });

  it("refuses to treat a 200 without a decision as permission", async () => {
    const brydge = fakeBrydge({ refuse: { "POST /api/supervise": () => new Response("{}", { status: 200 }) } });
    await expect(
      brydge.client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" }),
    ).rejects.toThrow(/without a decision/);
  });
});

describe("checking whether it happened", () => {
  it("verify reads the records now, with no body; finding reads what BRYDGE already has", async () => {
    const brydge = fakeBrydge();
    const now = await brydge.client.verify("sup_9");
    const [posted] = brydge.verifies();
    expect(posted!.path).toBe("/api/supervise/sup_9/verify");
    expect(posted!.body).toBeNull();
    expect(posted!.headers["content-type"]).toBeUndefined();
    expect(now).toMatchObject({ authorization: "sup_9", state: "VERIFIED", checkedAt: "2026-09-26T12:00:00.000Z" });

    const standing = await brydge.client.finding("sup_9");
    expect(brydge.sent.at(-1)!.method).toBe("GET");
    expect(standing).toEqual({
      authorization: "sup_9",
      state: "PENDING",
      reason: null,
      because: "BRYDGE has not checked this action yet.",
      externalRef: null,
      claimed: null,
      agentAgreed: null,
      checkedAt: null,
      replayed: false,
    });
  });

  it("cannot be pointed at another path by the authorization it is given", async () => {
    const brydge = fakeBrydge();
    await brydge.client.finding("../../api/keys?x=1").catch(() => undefined);
    expect(brydge.sent[0]!.path).toBe("/api/supervise/../../api/keys?x=1/verify");
    const raw = brydge.sent[0]!;
    expect(raw.method).toBe("GET");
    /* Encoded on the wire: one path segment, no query. */
    const onWire = new URL(`https://brydge.test/api/supervise/${encodeURIComponent("../../api/keys?x=1")}/verify`);
    expect(onWire.pathname.split("/")).toHaveLength(5);
    expect(onWire.search).toBe("");
  });

  it("reports what the agent says happened, beside the finding", async () => {
    const brydge = fakeBrydge();
    await brydge.client.report("sup_3", "SUCCEEDED", { by: "agent:refund-ops" });
    expect(brydge.reports()[0]).toMatchObject({ path: "/api/supervise/sup_3/outcome", body: { verdict: "SUCCEEDED", by: "agent:refund-ops" } });
  });

  it("asks for headroom by actor and action", async () => {
    const brydge = fakeBrydge();
    const room = await brydge.client.headroom("agent:refund-ops", "refund");
    const asked = new URL(`https://brydge.test${brydge.sent[0]!.path}`);
    expect(asked.pathname).toBe("/api/headroom");
    expect(Object.fromEntries(asked.searchParams)).toEqual({ actor: "agent:refund-ops", action: "refund" });
    expect(room.actions).toBe(1);
  });
});

describe("when BRYDGE does not answer the question", () => {
  it("a 402 is BRYDGE declining to look, carried as an error with its reason", async () => {
    const brydge = fakeBrydge({
      refuse: {
        "POST /api/supervise": () =>
          Response.json(
            { error: 'nothing has been declared for "refund"', reason: "nothing_declared", action: "refund" },
            { status: 402 },
          ),
      },
    });
    const error = await brydge.client
      .supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrydgeError);
    expect(error).toMatchObject({ status: 402, reason: "nothing_declared" });
    expect((error as Error).message).toMatch(/402.*nothing has been declared/);
  });

  it("a 429 says when to come back, from the body or the header", async () => {
    const fromBody = fakeBrydge({
      refuse: { "POST /api/supervise": () => Response.json({ error: "too many", retryAfterSeconds: 12 }, { status: 429 }) },
    });
    await expect(
      fromBody.client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 12 });

    const fromHeader = fakeBrydge({
      refuse: {
        "POST /api/supervise": () =>
          Response.json({ error: "could not check", reason: "entitlement_undeterminable" }, { status: 503, headers: { "retry-after": "5" } }),
      },
    });
    await expect(
      fromHeader.client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ status: 503, reason: "entitlement_undeterminable", retryAfterSeconds: 5 });
  });

  it("an unreachable BRYDGE is an error, with the cause kept", async () => {
    const down = new TypeError("fetch failed");
    const client = new BrydgeClient({
      apiKey: KEY,
      baseUrl: "https://brydge.test",
      fetch: async () => {
        throw down;
      },
    });
    const error = await client.verify("sup_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrydgeError);
    expect(error).toMatchObject({ status: null, cause: down });
    expect((error as Error).message).toMatch(/could not be reached: fetch failed/);
  });

  it("gives up after the timeout", async () => {
    const client = new BrydgeClient({
      apiKey: KEY,
      baseUrl: "https://brydge.test",
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    await expect(client.verify("sup_1")).rejects.toThrow(/did not answer within 50 ms/);
  });

  it("a cancel from the caller is the caller's, not dressed up as BRYDGE's", async () => {
    const client = new BrydgeClient({
      apiKey: KEY,
      baseUrl: "https://brydge.test",
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    const cancel = new AbortController();
    const pending = client.verify("sup_1", { signal: cancel.signal });
    cancel.abort(new Error("run cancelled"));
    await expect(pending).rejects.toThrow("run cancelled");
  });
});

describe("the package", () => {
  it("announces the version it is published as", () => {
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(version);
  });
});

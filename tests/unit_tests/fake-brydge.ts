import { BrydgeClient } from "../../src/client.js";

/*
 * BRYDGE's API, in memory, answering the way the real routes do: the same
 * paths, the same status codes and the same bodies. Every request is kept so a
 * test can say exactly what went over the wire.
 */

export interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Decide = (asked: Record<string, unknown>) => "ALLOWED" | "ESCALATED";
type Finding = { state: string; reason: string | null; because: string; externalRef?: string | null };

export function fakeBrydge(
  options: {
    decide?: Decide;
    finding?: (authorization: string) => Finding;
    /** Answer this path (method + path prefix, e.g. "POST /api/supervise") with a response instead. */
    refuse?: Record<string, () => Response | Promise<Response>>;
  } = {},
) {
  const sent: Sent[] = [];
  const byKey = new Map<string, { id: string; decision: "ALLOWED" | "ESCALATED" }>();
  const claims = new Map<string, string>();
  let next = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const path = decodeURIComponent(url.pathname) + url.search;
    sent.push({ method, path, headers, body });

    for (const [route, answer] of Object.entries(options.refuse ?? {})) {
      const [m, p] = route.split(" ");
      if (m === method && url.pathname.startsWith(p!)) return answer();
    }

    if (method === "POST" && url.pathname === "/api/supervise") {
      const key = String(body?.idempotencyKey);
      const earlier = byKey.get(key);
      if (earlier) return json(200, { ...earlier, mandateId: null, because: "replayed", checked: [], unobserved: [], replayed: true });
      const decision = (options.decide ?? (() => "ALLOWED"))(body ?? {});
      const answer = { id: `sup_${++next}`, decision };
      byKey.set(key, answer);
      return json(200, {
        ...answer,
        mandateId: decision === "ALLOWED" ? "mdt_1" : null,
        because: decision === "ALLOWED" ? "Within mandate mdt_1." : "No mandate covers refund for this agent.",
        checked: [],
        unobserved: decision === "ALLOWED" ? [] : ["amount"],
        replayed: false,
      });
    }

    const action = url.pathname.match(/^\/api\/supervise\/([^/]+)\/(outcome|verify)$/);
    if (action) {
      const id = decodeURIComponent(action[1]!);
      if (action[2] === "outcome" && method === "POST") {
        claims.set(id, String(body?.verdict));
        return json(201, { recorded: body?.verdict });
      }
      if (action[2] === "verify" && method === "GET") {
        return json(200, { state: "PENDING", reason: null, because: "BRYDGE has not checked this action yet.", checkedAt: null });
      }
      if (action[2] === "verify" && method === "POST") {
        const agree = (): Finding => ({ state: "VERIFIED", reason: null, because: "The destination's books agree." });
        const f = (options.finding ?? agree)(id);
        const claimed = claims.get(id) ?? null;
        return json(200, {
          id: `ver_${id}`,
          supervisionId: id,
          externalRef: f.externalRef ?? null,
          claimed,
          agentAgreed: claimed === null ? null : f.state === "VERIFIED" && claimed === "SUCCEEDED",
          checkedAt: "2026-09-26T12:00:00.000Z",
          replayed: false,
          ...f,
        });
      }
    }

    if (method === "GET" && url.pathname === "/api/headroom") {
      return json(200, { actor: url.searchParams.get("actor"), action: url.searchParams.get("action"), actions: 1, earned: 1 });
    }
    return json(404, { error: "no such route" });
  }) as typeof fetch;

  const client = new BrydgeClient({ apiKey: "brydge_sk_unit_test_key", baseUrl: "https://brydge.test", fetch: fetcher });
  const to = (method: string, prefix: string) => sent.filter((s) => s.method === method && s.path.startsWith(prefix));
  return {
    client,
    fetcher,
    sent,
    asked: () => to("POST", "/api/supervise").filter((s) => s.path === "/api/supervise"),
    reports: () => sent.filter((s) => s.method === "POST" && s.path.endsWith("/outcome")),
    verifies: () => sent.filter((s) => s.method === "POST" && s.path.endsWith("/verify")),
  };
}

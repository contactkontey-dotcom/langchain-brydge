import { FakeToolCallingModel, createAgent, tool, toolErrorMiddleware, ToolMessage } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BrydgeError,
  authorizationFor,
  brydgeMiddleware,
  supervisedActions,
  type SupervisedTool,
} from "../../src/index.js";
import { fakeBrydge } from "./fake-brydge.js";

/*
 * A real LangChain agent — createAgent, its tool node, its middleware chain —
 * driven by a scripted model, against BRYDGE's API answering in memory.
 */

const ACTOR = "agent:refund-ops";

type Call = { name: string; args: Record<string, unknown>; id: string };

/** A model that makes these tool calls, one turn per array, and then stops. */
const scripted = (...turns: Call[][]) => new FakeToolCallingModel({ toolCalls: [...turns, []] });

/** A refund tool that writes BRYDGE's authorization where the books will keep it. */
function refundTool(books: Array<{ authorization: string; paymentId: string; amount: unknown }> = []) {
  return tool(
    async ({ paymentId, amount }, config) => {
      books.push({ authorization: authorizationFor(config), paymentId, amount });
      return `Refunded ${paymentId}.`;
    },
    {
      name: "refund",
      description: "Refund a payment",
      schema: z.object({ paymentId: z.string(), amount: z.number() }),
    },
  );
}

function agentWith(
  brydge: ReturnType<typeof fakeBrydge>,
  model: FakeToolCallingModel,
  tools: Parameters<typeof createAgent>[0]["tools"],
  supervised: Record<string, SupervisedTool> = { refund: { target: "paymentId" } },
) {
  return createAgent({
    model,
    tools,
    middleware: [brydgeMiddleware({ actor: ACTOR, tools: supervised, client: brydge.client })],
  });
}

/** Any agent: the ones built here differ only in their middleware, which changes the type. */
type Agent = { invoke(input: unknown, config?: unknown): Promise<unknown> };

const run = async (agent: Agent, config?: Record<string, unknown>) =>
  (await agent.invoke({ messages: [{ role: "user", content: "Refund pi_1 in full." }] }, config)) as {
    messages: unknown[];
  };

const toolMessages = (result: { messages: unknown[] }) => result.messages.filter(ToolMessage.isInstance);

/** An error and everything it was caused by. */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e = error; e !== undefined && e !== null && chain.length < 8; e = (e as { cause?: unknown }).cause) chain.push(e);
  return chain;
}

describe("an allowed call", () => {
  it("runs with BRYDGE's authorization, is reported, and is recorded on its message", async () => {
    const brydge = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 4200 }, id: "call_1" }]), [
        refundTool(books),
      ]),
    );

    expect(brydge.asked()).toHaveLength(1);
    expect(brydge.asked()[0]!.body).toMatchObject({
      actor: ACTOR,
      action: "refund",
      target: "pi_1",
      facts: { paymentId: "pi_1", amount: 4200 },
    });
    expect(books).toEqual([{ authorization: "sup_1", paymentId: "pi_1", amount: 4200 }]);
    expect(brydge.reports().map((r) => [r.path, r.body])).toEqual([
      ["/api/supervise/sup_1/outcome", { verdict: "SUCCEEDED", by: ACTOR }],
    ]);

    const [message] = toolMessages(result);
    expect(message!.content).toBe("Refunded pi_1.");
    expect(message!.metadata?.brydge).toEqual({
      authorization: "sup_1",
      tool: "refund",
      toolCallId: "call_1",
      actor: ACTOR,
      action: "refund",
      target: "pi_1",
      decision: "ALLOWED",
      carriedOut: true,
      reported: "SUCCEEDED",
    });
  });

  it("gives each of several parallel calls its own authorization", async () => {
    const brydge = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    await run(
      agentWith(
        brydge,
        scripted([
          { name: "refund", args: { paymentId: "pi_1", amount: 100 }, id: "call_1" },
          { name: "refund", args: { paymentId: "pi_2", amount: 200 }, id: "call_2" },
        ]),
        [refundTool(books)],
      ),
    );
    const byPayment = Object.fromEntries(books.map((b) => [b.paymentId, b.authorization]));
    const asked = Object.fromEntries(brydge.asked().map((a, i) => [a.body!.target, `sup_${i + 1}`]));
    expect(byPayment).toEqual(asked);
    expect(new Set(Object.values(byPayment)).size).toBe(2);
  });
});

describe("an escalated call", () => {
  it("does not run, and the model is told a person is deciding", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 4200 }, id: "call_1" }]), [
        refundTool(books),
      ]),
    );

    expect(books).toEqual([]);
    expect(brydge.reports()).toEqual([]);
    const [message] = toolMessages(result);
    expect(message!.status).toBe("error");
    expect(message!.content).toMatch(/^Not done\. BRYDGE has passed this to a person/);
    expect(message!.content).toContain("No mandate covers refund for this agent.");
    expect(message!.content).toContain("BRYDGE was not told: amount.");
    expect(message!.content).toContain("BRYDGE authorization: sup_1.");
    expect(message!.metadata?.brydge).toMatchObject({ decision: "ESCALATED", carriedOut: false, reported: null });
  });
});

describe("tools BRYDGE is not asked about", () => {
  it("run untouched, and BRYDGE hears nothing", async () => {
    const brydge = fakeBrydge();
    const lookup = tool(async ({ paymentId }) => `pi status for ${paymentId}: succeeded`, {
      name: "lookup",
      description: "Look up a payment",
      schema: z.object({ paymentId: z.string() }),
    });
    const result = await run(
      agentWith(brydge, scripted([{ name: "lookup", args: { paymentId: "pi_1" }, id: "call_1" }]), [
        lookup,
        refundTool(),
      ]),
    );
    expect(brydge.sent).toEqual([]);
    expect(toolMessages(result)[0]!.metadata?.brydge).toBeUndefined();
  });
});

describe("when BRYDGE cannot be asked", () => {
  it("the tool does not run, and the run fails with BRYDGE's reason", async () => {
    const brydge = fakeBrydge({
      refuse: {
        "POST /api/supervise": () =>
          Response.json({ error: 'nothing declared for "refund"', reason: "nothing_declared" }, { status: 402 }),
      },
    });
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const outcome = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" }]), [
        refundTool(books),
      ]),
    ).catch((e: unknown) => e);
    /* LangChain wraps what a middleware throws; the BrydgeError is its cause. */
    expect(outcome).not.toBeInstanceOf(BrydgeError);
    expect(BrydgeError.find(outcome)).toMatchObject({ status: 402, reason: "nothing_declared" });
    expect(books).toEqual([]);
  });
});

describe("letting the model see a refusal instead", () => {
  /* toolErrorMiddleware first shipped in langchain 1.5.4. */
  it.skipIf(typeof toolErrorMiddleware !== "function")("works with LangChain's toolErrorMiddleware placed first", async () => {
    const brydge = fakeBrydge({
      refuse: { "POST /api/supervise": () => Response.json({ error: "rate limited", retryAfterSeconds: 30 }, { status: 429 }) },
    });
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const agent = createAgent({
      model: scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" }]),
      tools: [refundTool(books)],
      middleware: [
        toolErrorMiddleware({
          onError: (error) => {
            const refused = BrydgeError.find(error);
            return refused ? `Not done: BRYDGE could not be asked. Try again in ${refused.retryAfterSeconds}s.` : undefined;
          },
        }),
        brydgeMiddleware({ actor: ACTOR, tools: { refund: { target: "paymentId" } }, client: brydge.client }),
      ],
    });
    const result = await run(agent);
    expect(books).toEqual([]);
    const [message] = toolMessages(result);
    expect([message!.status, message!.content]).toEqual(["error", "Not done: BRYDGE could not be asked. Try again in 30s."]);
  });
});

describe("what the middleware reports", () => {
  it("passes a tool's own error through unchanged, and reports nothing", async () => {
    const brydge = fakeBrydge();
    const declined = new Error("card_declined");
    const failing = tool(
      async (_args, config) => {
        authorizationFor(config);
        throw declined;
      },
      { name: "refund", description: "Refund", schema: z.object({ paymentId: z.string() }) },
    );
    const outcome = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1" }, id: "call_1" }]), [failing]),
    ).catch((e: unknown) => e);
    /* The middleware neither catches nor replaces it. Before langchain 1.5,
     * LangChain itself wraps it in a MiddlewareError; the original is the cause. */
    expect(causes(outcome)).toContain(declined);
    expect(brydge.asked()).toHaveLength(1);
    expect(brydge.reports()).toEqual([]);
  });

  it("does not report a success for a tool that returned an error", async () => {
    const brydge = fakeBrydge();
    const erring = tool(
      async (_args, config) =>
        new ToolMessage({
          content: "Stripe said: card_declined",
          status: "error",
          tool_call_id: String((config as { toolCall?: { id?: string } }).toolCall?.id),
        }),
      { name: "refund", description: "Refund", schema: z.object({ paymentId: z.string() }) },
    );
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1" }, id: "call_1" }]), [erring]),
    );
    expect(brydge.reports()).toEqual([]);
    expect(toolMessages(result)[0]!.metadata?.brydge).toMatchObject({ carriedOut: true, reported: null });
  });

  it("reports what outcome() says, where the tool knows better", async () => {
    const brydge = fakeBrydge();
    await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" }]), [refundTool()], {
        refund: { target: "paymentId", outcome: () => "FAILED" },
      }),
    );
    expect(brydge.reports()[0]!.body).toEqual({ verdict: "FAILED", by: ACTOR });
  });

  it("keeps the tool's result when outcome() itself throws: the work is already done", async () => {
    const brydge = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" }]), [refundTool(books)], {
        refund: {
          target: "paymentId",
          outcome: () => {
            throw new Error("cannot read the processor's reply");
          },
        },
      }),
    );
    expect(books).toHaveLength(1);
    expect(brydge.reports()).toEqual([]);
    const [message] = toolMessages(result);
    expect(message!.content).toBe("Refunded pi_1.");
    expect(message!.metadata?.brydge).toMatchObject({ carriedOut: true, reported: null, reportError: "cannot read the processor's reply" });
  });

  it("keeps the tool's result when the report cannot be delivered", async () => {
    const brydge = fakeBrydge({
      refuse: { "POST /api/supervise/": () => Response.json({ error: "down" }, { status: 500 }) },
    });
    /* `refuse` above also matches the outcome path; supervise itself is answered normally. */
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" }]), [refundTool()]),
    );
    const [message] = toolMessages(result);
    expect(message!.content).toBe("Refunded pi_1.");
    expect(message!.metadata?.brydge).toMatchObject({ carriedOut: true, reported: null });
    expect((message!.metadata?.brydge as { reportError?: string }).reportError).toMatch(/500/);
  });
});

describe("what BRYDGE is told about a call", () => {
  it("names the target by argument or by function, and stops a call with no target before asking", async () => {
    const byFunction = fakeBrydge();
    await run(
      agentWith(byFunction, scripted([{ name: "refund", args: { paymentId: "pi_7", amount: 1 }, id: "call_1" }]), [refundTool()], {
        refund: { target: (args) => `payment:${args.paymentId}` },
      }),
    );
    expect(byFunction.asked()[0]!.body!.target).toBe("payment:pi_7");

    const missing = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const result = await run(
      agentWith(missing, scripted([{ name: "refund", args: { amount: 1 }, id: "call_1" }]), [refundTool(books)]),
    );
    expect(missing.sent).toEqual([]);
    expect(books).toEqual([]);
    const [message] = toolMessages(result);
    expect(message!.status).toBe("error");
    expect(message!.content).toMatch(/the "paymentId" argument is missing or empty/);
  });

  it("sends the call's plain arguments as facts, or what facts() returns", async () => {
    const byDefault = fakeBrydge();
    await run(
      agentWith(
        byDefault,
        scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 5, note: null, items: [1, 2], meta: { a: 1 } }, id: "c" }]),
        [refundTool()],
      ),
    );
    expect(byDefault.asked()[0]!.body!.facts).toEqual({ paymentId: "pi_1", amount: 5, note: null });

    const chosen = fakeBrydge();
    await run(
      agentWith(chosen, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 5 }, id: "c" }]), [refundTool()], {
        refund: { action: "payment_refund", target: "paymentId", facts: (a) => ({ amount: a.amount * 100, currency: "GBP" }) },
      }),
    );
    expect(chosen.asked()[0]!.body).toMatchObject({ action: "payment_refund", facts: { amount: 500, currency: "GBP" } });
  });

  it("refuses facts BRYDGE cannot judge, before anything runs", async () => {
    const brydge = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const outcome = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 5 }, id: "c" }]), [refundTool(books)], {
        refund: { target: "paymentId", facts: () => ({ lines: [1, 2] as never }) },
      }),
    ).catch((e: unknown) => e);
    expect(BrydgeError.find(outcome)?.message).toMatch(/"lines" as object/);
    expect(brydge.sent).toEqual([]);
    expect(books).toEqual([]);
  });

  it("asks a retry in the same conversation under the same key, whatever its tool call id", async () => {
    /*
     * The key used to carry the tool call id, so a model retrying after "a
     * person decides" — which is a new tool call — asked as a new action, and
     * the person's answer to the first could never reach it.
     */
    const brydge = fakeBrydge();
    const once = (args: Record<string, unknown>, id: string, thread: string) =>
      run(agentWith(brydge, scripted([{ name: "refund", args, id }]), [refundTool()]), { configurable: { thread_id: thread } });
    await once({ paymentId: "pi_1", amount: 5 }, "call_1", "thread-a");
    await once({ paymentId: "pi_1", amount: 5 }, "call_2", "thread-a");
    await once({ paymentId: "pi_1", amount: 6 }, "call_3", "thread-a");
    await once({ paymentId: "pi_2", amount: 5 }, "call_4", "thread-a");
    await once({ paymentId: "pi_1", amount: 5 }, "call_5", "thread-b");
    const keys = brydge.asked().map((a) => String(a.body!.idempotencyKey));
    expect(keys[0]).toMatch(/^langchain:[0-9a-f]{40}$/);
    expect(keys[1]).toBe(keys[0]);
    /* A different amount, a different payment, another conversation: each its own action. */
    expect(new Set([keys[0], keys[2], keys[3], keys[4]]).size).toBe(4);
  });

  it("without a thread, a retry within the run shares the key and a separate run does not", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const args = { paymentId: "pi_1", amount: 5 };
    /* One run: the model is told a person decides and tries again at once. */
    await run(
      agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }], [{ name: "refund", args, id: "call_2" }]), [
        refundTool(),
      ]),
    );
    /* A separate run, with no thread to say it is the same conversation. */
    await run(agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }]), [refundTool()]));
    const keys = brydge.asked().map((a) => String(a.body!.idempotencyKey));
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("names the action by the tool's own key in every thread, and still by what is asked", async () => {
    const brydge = fakeBrydge();
    const supervised = { refund: { target: "paymentId", key: (a: Record<string, any>) => `refund:${a.paymentId}` } };
    const once = (args: Record<string, unknown>, thread: string) =>
      run(agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }]), [refundTool()], supervised), {
        configurable: { thread_id: thread },
      });
    await once({ paymentId: "pi_1", amount: 5 }, "thread-a");
    await once({ paymentId: "pi_1", amount: 5 }, "thread-b");
    await once({ paymentId: "pi_1", amount: 9 }, "thread-b");
    const keys = brydge.asked().map((a) => String(a.body!.idempotencyKey));
    expect(keys[1]).toBe(keys[0]);
    /* The same name with a different amount is not the same action, and must not be told it is. */
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("refuses a key that names nothing", async () => {
    const brydge = fakeBrydge();
    const outcome = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 5 }, id: "c" }]), [refundTool()], {
        refund: { target: "paymentId", key: () => " " },
      }),
    ).catch((e: unknown) => e);
    expect(BrydgeError.find(outcome)?.message).toMatch(/key\(\) for "refund" must return a non-empty string/);
    expect(brydge.sent).toEqual([]);
  });
});

describe("a person's answer reaches the agent", () => {
  const thread = { configurable: { thread_id: "thread-approval" } };
  const args = { paymentId: "pi_1", amount: 4200 };

  it("escalated, then allowed by a person: the retry goes ahead, once, under the same authorization", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const agent = agentWith(
      brydge,
      scripted([{ name: "refund", args, id: "call_1" }], [{ name: "refund", args, id: "call_2" }], [{ name: "refund", args, id: "call_3" }]),
      [refundTool(books)],
    );

    /* Turn one: a person has to decide. The model is told how it will hear the answer — in its own terms. */
    const first = await run(agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }]), [refundTool(books)]), thread);
    const [waiting] = toolMessages(first);
    expect(waiting!.content).toMatch(/^Not done\. BRYDGE has passed this to a person/);
    expect(waiting!.content).toContain("Once they have answered, call refund again with the same arguments");
    expect(waiting!.content).not.toMatch(/idempotency key/);
    expect(books).toEqual([]);

    brydge.settle("sup_1", "ALLOWED");

    /* Turn two, a new tool call in the same conversation: it goes ahead. Asked again, it is not done twice. */
    const later = await run(agent, thread);
    expect(books).toEqual([{ authorization: "sup_1", paymentId: "pi_1", amount: 4200 }]);
    const [ran, again] = toolMessages(later);
    expect(ran!.metadata?.brydge).toMatchObject({ authorization: "sup_1", decision: "ALLOWED", carriedOut: true });
    expect(again!.content).toMatch(/^Already done\./);
    expect(again!.metadata?.brydge).toBeUndefined();
    expect(brydge.reports()).toHaveLength(1);
  });

  it("refused by a person: the retry is told so and nothing runs", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    await run(agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }]), [refundTool(books)]), thread);
    brydge.settle("sup_1", "REFUSED", "sam@example.com");

    const later = await run(agentWith(brydge, scripted([{ name: "refund", args, id: "call_2" }]), [refundTool(books)]), thread);
    const [message] = toolMessages(later);
    expect(message!.status).toBe("error");
    /* The person's name stays as BRYDGE gave it: an email is not a word to capitalise. */
    expect(message!.content).toMatch(
      /^Not done\. A person refused this, so it must not be carried out\. sam@example\.com refused this on 2026-10-02, so it must not be carried out\. BRYDGE authorization: sup_1\.$/,
    );
    expect(books).toEqual([]);
  });
});

describe("one authorization, one execution", () => {
  const args = { paymentId: "pi_1", amount: 5 };

  it("does not run an action again when the model asks for it twice, one after the other", async () => {
    const brydge = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }], [{ name: "refund", args, id: "call_2" }]), [
        refundTool(books),
      ]),
    );
    expect(books).toHaveLength(1);
    const [, again] = toolMessages(result);
    expect(again!.content).toMatch(/^Already done\. This refund was carried out earlier \(tool call call_1\)/);
    expect(brydge.reports()).toHaveLength(1);
  });

  it("does not run it twice when the model asks for it twice at once", async () => {
    const brydge = fakeBrydge();
    const books: Array<{ authorization: string; paymentId: string; amount: unknown }> = [];
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args, id: "call_1" }, { name: "refund", args, id: "call_2" }]), [
        refundTool(books),
      ]),
    );
    expect(books).toHaveLength(1);
    expect(toolMessages(result).map((m) => String(m.content).split(".")[0]).sort()).toEqual([
      "Already done",
      "Refunded pi_1",
    ]);
  });

  /* toolErrorMiddleware first shipped in langchain 1.5.4. */
  it.skipIf(typeof toolErrorMiddleware !== "function")(
    "lets the second of two calls at once go ahead when the first failed",
    async () => {
      const brydge = fakeBrydge();
      let attempts = 0;
      const flaky = tool(
        async ({ paymentId }) => {
          if (++attempts === 1) throw new Error("the processor timed out");
          return `Refunded ${paymentId}.`;
        },
        { name: "refund", description: "Refund a payment", schema: z.object({ paymentId: z.string(), amount: z.number() }) },
      );
      const agent = createAgent({
        model: scripted([{ name: "refund", args, id: "call_1" }, { name: "refund", args, id: "call_2" }]),
        tools: [flaky],
        middleware: [
          toolErrorMiddleware({ onError: (e) => `Failed: ${e instanceof Error ? e.message : String(e)}` }),
          brydgeMiddleware({ actor: ACTOR, tools: { refund: { target: "paymentId" } }, client: brydge.client }),
        ],
      });
      const result = await run(agent);
      expect(attempts).toBe(2);
      expect(toolMessages(result).map((m) => [m.status, m.content]).sort()).toEqual([
        ["error", "Failed: the processor timed out"],
        ["success", "Refunded pi_1."],
      ]);
    },
  );

  /* toolErrorMiddleware first shipped in langchain 1.5.4. */
  it.skipIf(typeof toolErrorMiddleware !== "function")("lets a run that failed be tried again", async () => {
    const brydge = fakeBrydge();
    let attempts = 0;
    const flaky = tool(
      async ({ paymentId }, config) => {
        if (++attempts === 1) throw new Error("the processor timed out");
        return `Refunded ${paymentId} under ${authorizationFor(config)}.`;
      },
      { name: "refund", description: "Refund a payment", schema: z.object({ paymentId: z.string(), amount: z.number() }) },
    );
    const agent = createAgent({
      model: scripted([{ name: "refund", args, id: "call_1" }], [{ name: "refund", args, id: "call_2" }]),
      tools: [flaky],
      middleware: [
        toolErrorMiddleware({ onError: (e) => `Failed: ${e instanceof Error ? e.message : String(e)}` }),
        brydgeMiddleware({ actor: ACTOR, tools: { refund: { target: "paymentId" } }, client: brydge.client }),
      ],
    });
    const result = await run(agent);
    expect(attempts).toBe(2);
    const [failed, retried] = toolMessages(result);
    expect(failed!.status).toBe("error");
    expect(retried!.content).toBe("Refunded pi_1 under sup_1.");
  });
});

describe("a tool that is not supervised", () => {
  it("cannot get an authorization, so it cannot act as though it had one", async () => {
    await expect(refundTool().invoke({ paymentId: "pi_1", amount: 1 })).rejects.toThrow(
      /ran without an authorization from BRYDGE/,
    );
  });
});

describe("setting the middleware up", () => {
  const client = fakeBrydge().client;
  it("needs an actor, at least one tool, and a target for each", () => {
    expect(() => brydgeMiddleware({ actor: " ", tools: { refund: { target: "id" } }, client })).toThrow(/needs an actor/);
    expect(() => brydgeMiddleware({ actor: ACTOR, tools: {}, client })).toThrow(/at least one tool/);
    expect(() => brydgeMiddleware({ actor: ACTOR, tools: { refund: {} as SupervisedTool }, client })).toThrow(
      /Tool "refund" needs a target/,
    );
  });
});

describe("checking a run afterwards", () => {
  it("verifies each action that was carried out, once, and skips the ones a person is deciding", async () => {
    let asked = 0;
    const brydge = fakeBrydge({
      decide: () => (++asked === 1 ? "ALLOWED" : "ESCALATED"),
      finding: (id) => ({ state: "VERIFIED", reason: null, because: `Books agree for ${id}.`, externalRef: "re_1" }),
    });
    const result = await run(
      agentWith(
        brydge,
        scripted([
          { name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" },
          { name: "refund", args: { paymentId: "pi_2", amount: 2 }, id: "call_2" },
        ]),
        [refundTool()],
      ),
    );

    expect(supervisedActions(result).map((a) => [a.toolCallId, a.decision, a.carriedOut])).toEqual([
      ["call_1", "ALLOWED", true],
      ["call_2", "ESCALATED", false],
    ]);

    const checks = await brydge.client.verifyWork(result.messages);
    expect(brydge.verifies().map((v) => v.path)).toEqual(["/api/supervise/sup_1/verify"]);
    expect(checks).toEqual([
      expect.objectContaining({
        tool: "refund",
        toolCallId: "call_1",
        target: "pi_1",
        authorization: "sup_1",
        state: "VERIFIED",
        because: "Books agree for sup_1.",
        externalRef: "re_1",
        claimed: "SUCCEEDED",
        agentAgreed: true,
      }),
    ]);
  });

  it("finds the record in messages read back as plain JSON", async () => {
    const brydge = fakeBrydge();
    const result = await run(
      agentWith(brydge, scripted([{ name: "refund", args: { paymentId: "pi_1", amount: 1 }, id: "call_1" }]), [refundTool()]),
    );
    const stored = JSON.parse(JSON.stringify(result.messages)) as unknown[];
    expect(supervisedActions(stored).map((a) => a.authorization)).toEqual(["sup_1"]);
    const plain = result.messages.map((m) => (ToolMessage.isInstance(m) ? { type: "tool", metadata: m.metadata } : {}));
    expect(supervisedActions({ messages: plain }).map((a) => a.authorization)).toEqual(["sup_1"]);
  });
});

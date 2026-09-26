import { FakeToolCallingModel, createAgent, tool, ToolMessage } from "langchain";
import { StructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BrydgeVerifyTool, authorizationFor, brydgeMiddleware, type WorkCheck } from "../../src/index.js";
import { fakeBrydge } from "./fake-brydge.js";

const refund = tool(
  async ({ paymentId }, config) => {
    authorizationFor(config);
    return `Refunded ${paymentId}.`;
  },
  { name: "refund", description: "Refund a payment", schema: z.object({ paymentId: z.string() }) },
);

/*
 * The checks LangChain's standard tool tests make, for a tool that has no
 * published JS suite to run them: a name, a description and a schema a model
 * can call, and a ToolMessage back when it is invoked with a tool call.
 */
describe("BrydgeVerifyTool, as a LangChain tool", () => {
  const verify = new BrydgeVerifyTool({ client: fakeBrydge().client });

  it("is a structured tool with a name, a description and an input schema", () => {
    expect(verify).toBeInstanceOf(StructuredTool);
    expect(verify.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(verify.description.length).toBeGreaterThan(40);
    expect(verify.schema.safeParse({}).success).toBe(true);
    expect(verify.schema.safeParse({ tool_call_id: "call_1" }).success).toBe(true);
    expect(verify.schema.safeParse({ tool_call_id: 7 }).success).toBe(false);
  });

  it("answers a tool call with a ToolMessage carrying the findings as its artifact", async () => {
    const message = await verify.invoke({ id: "call_9", name: verify.name, args: {}, type: "tool_call" });
    expect(message).toBeInstanceOf(ToolMessage);
    expect(message.tool_call_id).toBe("call_9");
    expect(Array.isArray(message.artifact)).toBe(true);
  });

  it("checks nothing outside an agent run, and says why", async () => {
    const message = await verify.invoke({ id: "call_9", name: verify.name, args: {}, type: "tool_call" });
    expect(message.content).toMatch(/called outside one/);
    expect(message.artifact).toEqual([]);
  });
});

describe("BrydgeVerifyTool, inside an agent", () => {
  it("lets the agent check its own work before it says it is done", async () => {
    const brydge = fakeBrydge({
      finding: () => ({ state: "MISMATCH", reason: "AMOUNT", because: "The refund in the books is for a different amount." }),
    });
    const agent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ name: "refund", args: { paymentId: "pi_1" }, id: "call_1" }],
          [{ name: "brydge_verify_work", args: {}, id: "call_2" }],
          [],
        ],
      }),
      tools: [refund, new BrydgeVerifyTool({ client: brydge.client })],
      middleware: [brydgeMiddleware({ actor: "agent:refund-ops", tools: { refund: { target: "paymentId" } }, client: brydge.client })],
    });
    const result = await agent.invoke({ messages: [{ role: "user", content: "Refund pi_1." }] });

    const answer = result.messages.filter(ToolMessage.isInstance).find((m) => m.tool_call_id === "call_2")!;
    expect(answer.content).toBe(
      "refund (call_1) on pi_1: MISMATCH. The refund in the books is for a different amount.",
    );
    expect((answer.artifact as WorkCheck[]).map((c) => [c.authorization, c.state, c.reason])).toEqual([
      ["sup_1", "MISMATCH", "AMOUNT"],
    ]);
    expect(brydge.verifies().map((v) => v.path)).toEqual(["/api/supervise/sup_1/verify"]);
    /* The check itself is not an action BRYDGE supervises. */
    expect(brydge.asked()).toHaveLength(1);
  });

  it("tells the model when BRYDGE could not check, rather than ending the run", async () => {
    const brydge = fakeBrydge({
      refuse: { "POST /api/supervise/sup_1/verify": () => Response.json({ error: "too many requests", retryAfterSeconds: 20 }, { status: 429 }) },
    });
    const agent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ name: "refund", args: { paymentId: "pi_1" }, id: "call_1" }],
          [{ name: "brydge_verify_work", args: {}, id: "call_2" }],
          [],
        ],
      }),
      tools: [refund, new BrydgeVerifyTool({ client: brydge.client })],
      middleware: [brydgeMiddleware({ actor: "agent:refund-ops", tools: { refund: { target: "paymentId" } }, client: brydge.client })],
    });
    const result = await agent.invoke({ messages: [{ role: "user", content: "Refund pi_1." }] });
    const answer = result.messages.filter(ToolMessage.isInstance).find((m) => m.tool_call_id === "call_2")!;
    expect(answer.content).toBe("Not checked. BRYDGE answered 429: too many requests");
    expect(answer.artifact).toEqual([]);
  });

  it("reports an escalated call as not carried out, without spending a check on it", async () => {
    const brydge = fakeBrydge({ decide: () => "ESCALATED" });
    const agent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ name: "refund", args: { paymentId: "pi_1" }, id: "call_1" }],
          [{ name: "brydge_verify_work", args: { tool_call_id: "call_1" }, id: "call_2" }],
          [],
        ],
      }),
      tools: [refund, new BrydgeVerifyTool({ client: brydge.client })],
      middleware: [brydgeMiddleware({ actor: "agent:refund-ops", tools: { refund: { target: "paymentId" } }, client: brydge.client })],
    });
    const result = await agent.invoke({ messages: [{ role: "user", content: "Refund pi_1." }] });
    const answer = result.messages.filter(ToolMessage.isInstance).find((m) => m.tool_call_id === "call_2")!;
    expect(answer.content).toBe("refund (call_1) on pi_1: not carried out. A person is deciding it.");
    expect(brydge.verifies()).toEqual([]);
  });
});

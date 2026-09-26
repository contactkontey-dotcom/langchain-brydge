import { StructuredTool, type ToolRunnableConfig } from "@langchain/core/tools";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";
import { z } from "zod";
import { BrydgeClient, type WorkCheck } from "./client.js";
import { BrydgeError } from "./errors.js";
import { isRecord, supervisedActions } from "./record.js";

const schema = z.object({
  tool_call_id: z
    .string()
    .optional()
    .describe("Check only the action from this tool call. Leave it out to check every action carried out so far."),
});

/**
 * A tool the agent calls to check its own work before it says the work is done.
 *
 * It needs no input from the model and accepts none that could change a
 * finding: it looks up the actions {@link brydgeMiddleware} recorded earlier
 * in the same run, and BRYDGE reads the destination's records for each.
 *
 * ```ts
 * const agent = createAgent({
 *   model,
 *   tools: [refund, new BrydgeVerifyTool()],
 *   middleware: [brydgeMiddleware({ actor: "agent:refund-ops", tools: { refund: { target: "paymentId" } } })],
 * });
 * ```
 */
export class BrydgeVerifyTool extends StructuredTool<typeof schema> {
  static lc_name() {
    return "BrydgeVerifyTool";
  }

  name = "brydge_verify_work";

  description =
    "Check whether the actions you carried out earlier in this conversation actually happened. BRYDGE reads " +
    "the destination system's own records and reports each action as VERIFIED (it happened as permitted), " +
    "FAILED, MISMATCH (something other than what was permitted happened), UNKNOWN (BRYDGE could not tell) or " +
    "PENDING (still in progress). Use it before you tell the user that work is done.";

  schema = schema;

  override responseFormat = "content_and_artifact" as const;

  readonly #client: BrydgeClient;

  constructor(fields: { client?: BrydgeClient } = {}) {
    super();
    this.#client = fields.client ?? new BrydgeClient();
  }

  protected async _call(
    input: z.infer<typeof schema>,
    _runManager?: CallbackManagerForToolRun,
    config?: ToolRunnableConfig,
  ): Promise<[string, WorkCheck[]]> {
    const state = isRecord(config) ? (config as Record<string, unknown>).state : undefined;
    const messages = isRecord(state) && Array.isArray(state.messages) ? state.messages : null;
    if (!messages) {
      return ["Nothing checked. This tool reads the actions from the agent run it is part of, and it was called outside one.", []];
    }

    const actions = supervisedActions(messages).filter(
      (a) => input.tool_call_id === undefined || a.toolCallId === input.tool_call_id,
    );
    if (actions.length === 0) {
      return [
        input.tool_call_id === undefined
          ? "Nothing to check. No action in this conversation has gone through BRYDGE."
          : `Nothing to check. The tool call ${input.tool_call_id} did not go through BRYDGE.`,
        [],
      ];
    }

    let checks: WorkCheck[];
    try {
      checks = await this.#client.verifyWork(messages, {
        ...(input.tool_call_id === undefined ? {} : { toolCallId: input.tool_call_id }),
        ...(config?.signal ? { signal: config.signal } : {}),
      });
    } catch (error) {
      /* Checking changes nothing, so a check BRYDGE could not make is an answer, not a failure of the run. */
      if (error instanceof BrydgeError) return [`Not checked. ${error.message}`, []];
      throw error;
    }
    const lines = actions.map((a) => {
      const check = checks.find((c) => c.authorization === a.authorization);
      const call = `${a.tool} (${a.toolCallId || "no call id"}) on ${a.target}`;
      if (!a.carriedOut) return `${call}: not carried out. A person is deciding it.`;
      return check ? `${call}: ${check.state}. ${check.because}` : `${call}: not checked.`;
    });
    return [lines.join("\n"), checks];
  }
}

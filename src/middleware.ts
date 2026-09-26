import { createMiddleware, ToolMessage } from "langchain";
import { BrydgeClient } from "./client.js";
import { BrydgeError } from "./errors.js";
import { AUTHORIZATION_KEY, RECORD_KEY, isRecord, type SupervisedAction } from "./record.js";
import type { Fact, Facts, Outcome, Supervision } from "./types.js";

/** A tool call's arguments, as the model produced them. `any`, so `(args) => args.orderId` needs no cast. */
export type ToolArgs = Record<string, any>;

/** How BRYDGE should see one tool. */
export interface SupervisedTool {
  /**
   * What BRYDGE calls this kind of work. Defaults to the tool's name. It must
   * match an action that has a declared value and a destination in BRYDGE.
   */
  action?: string;
  /**
   * What the call acts on: the payment, order or ticket. The name of an
   * argument, or a function of the arguments.
   */
  target: string | ((args: ToolArgs) => unknown);
  /**
   * What BRYDGE's mandates judge the call by. Defaults to the call's top-level
   * strings, numbers and booleans. BRYDGE compares a fact named `amount` with
   * the amount in the destination's record, so give it in the same units.
   */
  facts?: (args: ToolArgs) => Facts;
  /**
   * What to report to BRYDGE once the tool has run. Defaults to `SUCCEEDED`
   * when the tool returns normally and to nothing when it returns an error.
   * Return null to report nothing.
   */
  outcome?: (result: unknown) => Outcome | null;
}

export interface BrydgeMiddlewareOptions {
  /** The agent, as BRYDGE knows it, such as `agent:refund-ops`. Mandates are issued to this name. */
  actor: string;
  /** The tools BRYDGE supervises, by tool name. Every other tool runs untouched. */
  tools: Record<string, SupervisedTool>;
  /** Defaults to a client configured from `BRYDGE_API_KEY` and `BRYDGE_URL`. */
  client?: BrydgeClient;
}

/**
 * Supervise an agent's tool calls with BRYDGE.
 *
 * Before a listed tool runs, BRYDGE decides whether this agent may do it.
 * Allowed, the tool runs, and {@link authorizationFor} gives it the id to
 * write into the record it creates. Escalated, the tool does not run and the
 * model is told a person is deciding. Afterwards the middleware reports the
 * outcome, and every call is recorded on its tool message so
 * {@link BrydgeClient.verifyWork} can check the whole run.
 *
 * If BRYDGE cannot be asked, the tool does not run and the error is thrown.
 * Errors from the tool itself pass through unchanged.
 */
export function brydgeMiddleware(options: BrydgeMiddlewareOptions) {
  const actor = typeof options.actor === "string" ? options.actor.trim() : "";
  if (!actor) {
    throw new BrydgeError('brydgeMiddleware needs an actor: the name BRYDGE knows this agent by, such as "agent:refund-ops".');
  }
  const tools = options.tools ?? {};
  if (Object.keys(tools).length === 0) {
    throw new BrydgeError("brydgeMiddleware needs at least one tool to supervise, under `tools`.");
  }
  for (const [name, spec] of Object.entries(tools)) {
    if (!spec || (typeof spec.target !== "string" && typeof spec.target !== "function")) {
      throw new BrydgeError(`Tool "${name}" needs a target: the argument that names what it acts on, or a function returning it.`);
    }
  }
  const client = options.client ?? new BrydgeClient();

  return createMiddleware({
    name: "BrydgeMiddleware",
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      const spec = Object.hasOwn(tools, toolCall.name) ? tools[toolCall.name] : undefined;
      if (!spec) return handler(request);

      const args: ToolArgs = isRecord(toolCall.args) ? toolCall.args : {};
      const callId = toolCall.id ?? "";
      const action = (spec.action ?? toolCall.name).trim();

      const target = targetOf(spec, args);
      if (target === null) {
        /* The model left out what the call acts on. Nothing is asked and nothing is done. */
        return new ToolMessage({
          content:
            `Not done. BRYDGE could not tell what this ${toolCall.name} call acts on` +
            (typeof spec.target === "string"
              ? `: the "${spec.target}" argument is missing or empty. Call it again with that argument.`
              : "."),
          tool_call_id: callId,
          name: toolCall.name,
          status: "error",
        });
      }
      const facts = factsFor(spec, args, toolCall.name);

      const supervision = await client.supervise(
        {
          actor,
          action,
          target,
          facts,
          idempotencyKey: await idempotencyKey({ callId, thread: threadOf(request.runtime), actor, action, target, facts }),
        },
        { signal: request.runtime?.signal },
      );

      const record = (carriedOut: boolean, reported: Outcome | null, reportError?: string): SupervisedAction => ({
        authorization: supervision.id,
        tool: toolCall.name,
        toolCallId: callId,
        actor,
        action,
        target,
        decision: supervision.decision,
        carriedOut,
        reported,
        ...(reportError === undefined ? {} : { reportError }),
      });

      if (supervision.decision !== "ALLOWED") {
        return new ToolMessage({
          content: escalated(supervision),
          tool_call_id: callId,
          name: toolCall.name,
          status: "error",
          metadata: { [RECORD_KEY]: record(false, null) },
        });
      }

      const result = await handler(
        request.tool ? { ...request, tool: withAuthorization(request.tool, supervision.id) } : request,
      );

      /*
       * The tool has run. From here nothing may throw: an agent told its work
       * failed would try again, and the second attempt would be real.
       */
      let reported: Outcome | null = null;
      let reportError: string | undefined;
      try {
        const claim = (spec.outcome ?? claimOf)(result);
        if (claim) {
          await client.report(supervision.id, claim, { by: actor });
          reported = claim;
        }
      } catch (e) {
        reportError = e instanceof Error ? e.message : String(e);
      }
      if (ToolMessage.isInstance(result)) {
        result.metadata = { ...(result.metadata ?? {}), [RECORD_KEY]: record(true, reported, reportError) };
      }
      return result;
    },
  });
}

function targetOf(spec: SupervisedTool, args: ToolArgs): string | null {
  const raw = typeof spec.target === "function" ? spec.target(args) : args[spec.target];
  const value = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof value !== "string") return null;
  const target = value.trim();
  return target.length > 0 && target.length <= 400 ? target : null;
}

function factsFor(spec: SupervisedTool, args: ToolArgs, tool: string): Facts {
  if (!spec.facts) {
    const facts: Facts = {};
    for (const [name, value] of Object.entries(args)) if (isFact(value)) facts[name] = value;
    return facts;
  }
  const facts = spec.facts(args);
  if (!isRecord(facts)) throw new BrydgeError(`facts() for "${tool}" must return an object.`);
  for (const [name, value] of Object.entries(facts)) {
    if (!isFact(value)) {
      throw new BrydgeError(`facts() for "${tool}" returned "${name}" as ${typeof value}; facts are strings, numbers, booleans or null.`);
    }
  }
  return facts;
}

const isFact = (v: unknown): v is Fact =>
  typeof v === "string" || typeof v === "boolean" || v === null || (typeof v === "number" && Number.isFinite(v));

/** Normal return: the agent will say it worked, so that is the report. An error: say nothing. */
function claimOf(result: unknown): Outcome | null {
  if (ToolMessage.isInstance(result)) return result.status === "error" ? null : "SUCCEEDED";
  return "SUCCEEDED";
}

function threadOf(runtime: unknown): string | null {
  const configurable = isRecord(runtime) ? runtime.configurable : undefined;
  const thread = isRecord(configurable) ? configurable.thread_id : undefined;
  return typeof thread === "string" || typeof thread === "number" ? String(thread) : null;
}

/**
 * The same call, retried, gets the same answer from BRYDGE. A different call
 * never does, even where a model reuses tool call ids: the key covers what is
 * being asked as well as which call asked it.
 */
async function idempotencyKey(parts: {
  callId: string;
  thread: string | null;
  actor: string;
  action: string;
  target: string;
  facts: Facts;
}): Promise<string> {
  const asked = JSON.stringify([
    parts.thread,
    parts.actor,
    parts.action,
    parts.target,
    Object.keys(parts.facts)
      .sort()
      .map((name) => [name, parts.facts[name]]),
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(asked)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `langchain:${parts.callId ? parts.callId.slice(0, 200) : crypto.randomUUID()}:${hex.slice(0, 32)}`;
}

function escalated(supervision: Supervision): string {
  return [
    "Not done. BRYDGE has passed this to a person to decide, so it was not carried out.",
    supervision.because,
    supervision.unobserved.length > 0 ? `BRYDGE was not told: ${supervision.unobserved.join(", ")}.` : "",
    `BRYDGE authorization: ${supervision.id}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The same tool, invoked with BRYDGE's authorization in its config. */
function withAuthorization<T extends object>(tool: T, authorization: string): T {
  return new Proxy(tool, {
    get(target, property) {
      if (property === "invoke") {
        return (input: unknown, config?: Record<string, unknown>) =>
          (target as unknown as { invoke: (i: unknown, c?: Record<string, unknown>) => unknown }).invoke(input, {
            ...config,
            configurable: {
              ...(isRecord(config?.configurable) ? config.configurable : {}),
              [AUTHORIZATION_KEY]: authorization,
            },
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

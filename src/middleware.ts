import { createMiddleware, HumanMessage, ToolMessage } from "langchain";
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
  /**
   * A name for this one intended action, when your system has one: usually
   * built from the id the work is about, such as
   * `(args) => \`refund:${args.chargeId}\``.
   *
   * Every call with the same key, target and facts is the same action to
   * BRYDGE in any thread and any process: a retry gets the same answer, and
   * once a person allows an escalated one, the next call goes ahead. Without
   * it, the action is named within the conversation — the run's `thread_id`,
   * or the current run when there is none.
   */
  key?: (args: ToolArgs) => string;
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
 * model is told a person is deciding, and to call the tool again with the same
 * arguments once they have: the retry asks under the same idempotency key, so
 * a person's answer reaches it. Afterwards the middleware reports the outcome,
 * and every call is recorded on its tool message so
 * {@link BrydgeClient.verifyWork} can check the whole run.
 *
 * An authorization is carried out once. A retry of an action that already ran
 * is told so, and the tool does not run again.
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
    if (spec.key !== undefined && typeof spec.key !== "function") {
      throw new BrydgeError(`Tool "${name}": key must be a function of the call's arguments.`);
    }
  }
  const client = options.client ?? new BrydgeClient();
  /* Authorizations this middleware has carried out, or is carrying out now. */
  const carried = new Carried();

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
          idempotencyKey: await idempotencyKey({
            scope: scopeOf(spec, args, toolCall.name, request, callId),
            actor,
            action,
            target,
            facts,
          }),
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
          content: escalated(supervision, toolCall.name),
          tool_call_id: callId,
          name: toolCall.name,
          status: "error",
          metadata: { [RECORD_KEY]: record(false, null) },
        });
      }

      /*
       * ONE AUTHORIZATION, ONE EXECUTION. A retry asks under the same key, so
       * an action that already ran gets its ALLOWED back — and running the tool
       * again would do the work twice under one permission. Checked against
       * this run's own messages (and a checkpointed thread's), and against what
       * this process has carried out: a parallel call waits for the one already
       * carrying it out, and goes ahead only if that one failed.
       */
      const earlier = ranEarlier(request.state, supervision.id);
      const running = earlier ? null : await carried.claim(supervision.id);
      if (!running) {
        return new ToolMessage({
          content:
            `Already done. This ${toolCall.name} was carried out ${earlier ? `earlier (tool call ${earlier})` : "already"} ` +
            `under BRYDGE authorization ${supervision.id}, so it was not carried out again. A second, separate ` +
            `${toolCall.name} needs different arguments.`,
          tool_call_id: callId,
          name: toolCall.name,
          /* Not an error: the work is done. No record either — the earlier
           * call's record is the one that stands. */
          status: "success",
        });
      }

      let result: Awaited<ReturnType<typeof handler>>;
      try {
        result = await handler(
          request.tool ? { ...request, tool: withAuthorization(request.tool, supervision.id) } : request,
        );
      } catch (e) {
        /* It threw: whether anything happened is unknown, and a retry may try again. */
        running.finish(false);
        throw e;
      }
      running.finish(!(ToolMessage.isInstance(result) && result.status === "error"));

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
 * Where one intended action lives, which decides what counts as a retry.
 *
 * In order: the tool's own `key`, which names the action everywhere; the run's
 * `thread_id`, so a retry in a later turn of the conversation is the same
 * action; the current run, named by the human message it answers, so a model
 * retrying straight away does not open a second escalation; and, only when
 * there is none of those, the tool call itself.
 *
 * WHY NOT THE TOOL CALL. That is what this used, and it made every retry a new
 * action: a model told "a person decides" calls the tool again under a new
 * call id, BRYDGE saw a new request, escalated it afresh, and the person's
 * answer to the first never reached the agent at all.
 */
function scopeOf(
  spec: SupervisedTool,
  args: ToolArgs,
  tool: string,
  request: { runtime?: unknown; state?: unknown },
  callId: string,
): string {
  if (spec.key) {
    const named = spec.key(args);
    if (typeof named !== "string" || named.trim().length === 0 || named.length > 200) {
      throw new BrydgeError(`key() for "${tool}" must return a non-empty string of at most 200 characters.`);
    }
    return `key:${named.trim()}`;
  }
  const thread = threadOf(request.runtime);
  if (thread) return `thread:${thread}`;
  const run = humanMessageIdOf(request.state);
  if (run) return `run:${run}`;
  return `call:${callId || crypto.randomUUID()}`;
}

/** The id of the newest human message in this state: the turn this run is answering. */
function humanMessageIdOf(state: unknown): string | null {
  const messages = isRecord(state) && Array.isArray(state.messages) ? state.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: unknown = messages[i];
    if (HumanMessage.isInstance(m)) return typeof m.id === "string" && m.id.length > 0 ? m.id : null;
  }
  return null;
}

/**
 * The idempotency key for one intended action: where it lives and what is
 * asked, hashed. A different action never shares one — the key covers the
 * actor, the action, the target and every fact — and a retry of the same
 * action in the same place always does.
 */
async function idempotencyKey(parts: {
  scope: string;
  actor: string;
  action: string;
  target: string;
  facts: Facts;
}): Promise<string> {
  const asked = JSON.stringify([
    parts.scope,
    parts.actor,
    parts.action,
    parts.target,
    Object.keys(parts.facts)
      .sort()
      .map((name) => [name, parts.facts[name]]),
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(asked)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `langchain:${hex.slice(0, 40)}`;
}

/**
 * Whether this authorization already ran, by the records in this state: the
 * tool call that ran it, or null. A run that ended in an error does not count —
 * the retry is the point of it.
 */
function ranEarlier(state: unknown, authorization: string): string | null {
  const messages = isRecord(state) && Array.isArray(state.messages) ? state.messages : [];
  for (const m of messages) {
    if (!ToolMessage.isInstance(m) || m.status === "error") continue;
    const raw = isRecord(m.metadata) ? m.metadata[RECORD_KEY] : undefined;
    if (isRecord(raw) && raw.authorization === authorization && raw.carriedOut === true) {
      return typeof raw.toolCallId === "string" && raw.toolCallId ? raw.toolCallId : m.tool_call_id;
    }
  }
  return null;
}

/**
 * Authorizations this middleware has carried out, or is carrying out now.
 *
 * For parallel calls and for runs whose earlier messages are not in state. An
 * id is BRYDGE's and unique, so one process-wide map cannot confuse two
 * actions. Bounded: the oldest finished ones are forgotten first.
 */
class Carried {
  /* true once carried out; while it runs, a promise of whether it was. */
  #ids = new Map<string, true | Promise<boolean>>();

  /**
   * Claims an authorization to carry out, or null if it has been carried out
   * already. While another call is carrying it out, waits to see whether it
   * did. The look and the claim happen with nothing in between, so two calls
   * never both hold one.
   */
  async claim(authorization: string): Promise<{ finish(carriedOut: boolean): void } | null> {
    for (;;) {
      const seen = this.#ids.get(authorization);
      if (seen === true) return null;
      if (seen === undefined) break;
      await seen;
    }
    let settle: (carriedOut: boolean) => void = () => {};
    this.#ids.set(authorization, new Promise<boolean>((resolve) => (settle = resolve)));
    this.#trim();
    return {
      finish: (carriedOut) => {
        if (carriedOut) this.#ids.set(authorization, true);
        else this.#ids.delete(authorization);
        settle(carriedOut);
      },
    };
  }

  #trim(): void {
    if (this.#ids.size <= 10_000) return;
    for (const [id, seen] of this.#ids) {
      if (seen === true) {
        this.#ids.delete(id);
        return;
      }
    }
  }
}

/** What the model is told when BRYDGE did not allow the call. */
function escalated(supervision: Supervision, tool: string): string {
  if (supervision.settled === "REFUSED") {
    return [
      "Not done. A person refused this, so it must not be carried out.",
      sentence(supervision.because),
      `BRYDGE authorization: ${supervision.id}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  /* BRYDGE's own sentence tells an API caller to reuse its idempotency key.
   * Here the middleware owns the key, so the model is told what it can do. */
  const next = supervision.next?.trim();
  const because =
    next && supervision.because.endsWith(next) ? supervision.because.slice(0, -next.length) : supervision.because;
  return [
    "Not done. BRYDGE has passed this to a person to decide, so it was not carried out.",
    sentence(because),
    supervision.unobserved.length > 0 ? `BRYDGE was not told: ${supervision.unobserved.join(", ")}.` : "",
    `Once they have answered, call ${tool} again with the same arguments: if they allowed it, it goes ahead then.`,
    `BRYDGE authorization: ${supervision.id}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** BRYDGE's reason as a sentence of its own: a capital, a full stop, or nothing at all. */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s*\.+$/, ".");
  if (trimmed === "" || trimmed === ".") return "";
  /* A plain first word takes a capital; a name or an id, such as a person's email, stays as it was given. */
  const capital = /^[a-z]+(?![\w@.:-])/.test(trimmed) ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
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

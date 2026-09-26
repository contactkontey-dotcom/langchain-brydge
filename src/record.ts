import { BrydgeError } from "./errors.js";
import type { Decision, Outcome } from "./types.js";

/**
 * Where the middleware puts BRYDGE's authorization in a tool's config, under
 * `config.configurable`. Read it with {@link authorizationFor}.
 */
export const AUTHORIZATION_KEY = "brydge_authorization";

/** Where the middleware records each supervised call, under `ToolMessage.metadata`. */
export const RECORD_KEY = "brydge";

/** One tool call that went through BRYDGE, as the middleware recorded it on the tool's message. */
export interface SupervisedAction {
  /** BRYDGE's id for this action. The destination's record of the work carries it. */
  authorization: string;
  /** The LangChain tool that was called. */
  tool: string;
  toolCallId: string;
  actor: string;
  action: string;
  target: string;
  decision: Decision;
  /** Whether the tool ran. False when BRYDGE passed the action to a person. */
  carriedOut: boolean;
  /** What the middleware reported to BRYDGE for the agent. Null when it reported nothing. */
  reported: Outcome | null;
  /** Why the report did not reach BRYDGE, when it did not. The tool had already run. */
  reportError?: string;
}

/** An agent's messages, or the state an agent run returns (anything with `messages`). */
export type MessagesLike = readonly unknown[] | { readonly messages?: readonly unknown[] };

/**
 * The authorization BRYDGE issued for the tool call now running.
 *
 * Call it inside a supervised tool and write the value into the record your
 * tool creates at the destination: a payment's metadata, an issue's body, a
 * ticket's custom field. BRYDGE finds the work by this id and by nothing else.
 *
 * Throws when the tool was not called through {@link brydgeMiddleware}, so a
 * tool never acts without BRYDGE's permission.
 *
 * @param config The second argument LangChain passes to a tool function.
 */
export function authorizationFor(config: unknown): string {
  const configurable = isRecord(config) ? config.configurable : undefined;
  const id = isRecord(configurable) ? configurable[AUTHORIZATION_KEY] : undefined;
  if (typeof id === "string" && id.length > 0) return id;
  throw new BrydgeError(
    "This tool ran without an authorization from BRYDGE, so it must not act. Add brydgeMiddleware() to the " +
      "agent and list this tool under `tools`. Otherwise BRYDGE will find the work with no permission behind it.",
  );
}

/**
 * Every tool call in these messages that went through BRYDGE, oldest first.
 *
 * Reads what the middleware wrote on each tool message, so it works on the
 * state an agent returns, on messages read back from a checkpointer, and on
 * messages stored as plain JSON.
 */
export function supervisedActions(input: MessagesLike): SupervisedAction[] {
  const messages: readonly unknown[] = Array.isArray(input)
    ? input
    : Array.isArray((input as { messages?: unknown }).messages)
      ? ((input as { messages: readonly unknown[] }).messages)
      : [];
  const latest = new Map<string, SupervisedAction>();
  for (const message of messages) {
    const action = recordOn(message);
    if (!action) continue;
    /* A call retried under one authorization leaves one action, not two. */
    latest.delete(action.authorization);
    latest.set(action.authorization, action);
  }
  return [...latest.values()];
}

function recordOn(message: unknown): SupervisedAction | null {
  if (!isRecord(message)) return null;
  /* A live ToolMessage keeps metadata on itself; a serialized one under `kwargs`. */
  const metadata = isRecord(message.metadata)
    ? message.metadata
    : isRecord(message.kwargs) && isRecord(message.kwargs.metadata)
      ? message.kwargs.metadata
      : null;
  const raw = metadata?.[RECORD_KEY];
  if (!isRecord(raw)) return null;
  if (typeof raw.authorization !== "string" || raw.authorization.length === 0) return null;
  if (raw.decision !== "ALLOWED" && raw.decision !== "ESCALATED") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    authorization: raw.authorization,
    tool: text(raw.tool),
    toolCallId: text(raw.toolCallId),
    actor: text(raw.actor),
    action: text(raw.action),
    target: text(raw.target),
    decision: raw.decision,
    carriedOut: raw.carriedOut === true,
    reported: isOutcome(raw.reported) ? raw.reported : null,
    ...(typeof raw.reportError === "string" ? { reportError: raw.reportError } : {}),
  };
}

const OUTCOMES: ReadonlySet<string> = new Set([
  "SUCCEEDED",
  "FAILED",
  "REVERSED",
  "CORRECTED",
  "WRONGLY_ALLOWED",
  "WRONGLY_REFUSED",
]);

export const isOutcome = (v: unknown): v is Outcome => typeof v === "string" && OUTCOMES.has(v);

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

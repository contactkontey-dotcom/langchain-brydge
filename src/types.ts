/**
 * What BRYDGE decided before an action happened.
 *
 * - `ALLOWED`: a mandate a person issued covers it, and the agent has room left today.
 * - `ESCALATED`: a person decides. The action has not been done.
 */
export type Decision = "ALLOWED" | "ESCALATED";

/**
 * What BRYDGE found when it read the destination's own records.
 *
 * Only `VERIFIED` means the work happened as permitted. `UNKNOWN` means BRYDGE
 * could not tell, which is not the same as failure.
 */
export type VerificationState = "PENDING" | "VERIFIED" | "FAILED" | "MISMATCH" | "UNKNOWN";

/** Why BRYDGE reached its finding. A closed set, safe to branch on. */
export type VerificationReason =
  /* BRYDGE could not look. */
  | "NO_DESTINATION"
  | "NO_CREDENTIAL"
  | "NOT_ATTESTED"
  | "UNREACHABLE"
  | "MALFORMED"
  /* BRYDGE looked and could not conclude. */
  | "NO_MATCH"
  | "UNKNOWN_STATUS"
  /* BRYDGE looked and found something other than what was permitted. */
  | "CORRELATION"
  | "DUPLICATE_EXECUTION"
  | "UNAUTHORISED_EXECUTION"
  | "ACTION"
  | "ACTOR"
  | "TARGET"
  | "AMOUNT"
  /* BRYDGE looked and concluded. */
  | "NOT_EXECUTED"
  | "DECLINED"
  | "STILL_PROCESSING";

/** What an agent reports happened. BRYDGE compares it with the records; it decides nothing. */
export type Outcome =
  | "SUCCEEDED"
  | "FAILED"
  | "REVERSED"
  | "CORRECTED"
  | "WRONGLY_ALLOWED"
  | "WRONGLY_REFUSED";

export type Fact = string | number | boolean | null;

/** What BRYDGE's mandates judge an action by, such as `{ amount: 4200, currency: "GBP" }`. */
export type Facts = Record<string, Fact>;

/** How one condition of the closest mandate read the facts. */
export interface ConditionResult {
  fact: string;
  state: "MET" | "UNMET" | "UNOBSERVED" | "UNCOMPARABLE";
  because: string;
}

/** BRYDGE's answer to "may this agent do this?" */
export interface Supervision {
  /**
   * The authorization: BRYDGE's id for this one action. The record the action
   * leaves at the destination must carry it, or BRYDGE cannot find it.
   */
  id: string;
  decision: Decision;
  /** The mandate that allowed it. Null on every escalation. */
  mandateId: string | null;
  because: string;
  checked: ConditionResult[];
  /** Facts a mandate needed that nobody supplied. */
  unobserved: string[];
  /** True when BRYDGE had already answered this exact request. */
  replayed: boolean;
}

/** What BRYDGE found about one action. */
export interface Verification {
  /** The authorization this finding is about. */
  authorization: string;
  state: VerificationState;
  reason: VerificationReason | null;
  /** One plain sentence. */
  because: string;
  /** The destination's own reference for the record BRYDGE matched. */
  externalRef: string | null;
  /** What the agent reported, shown beside the finding. It did not decide it. */
  claimed: Outcome | null;
  /** Whether the report survived the records. Null where there was no report or nothing was established. */
  agentAgreed: boolean | null;
  /** When BRYDGE read the records. Null if it has not checked yet. */
  checkedAt: string | null;
  /** True when BRYDGE saw exactly what an earlier check saw, and returned that finding. */
  replayed: boolean;
}

/** How much this agent may do without a person, in any 24 hours. */
export interface Headroom {
  actor: string;
  action: string;
  asOf: string;
  /** The number: actions this agent may take in 24 hours before a person is asked. */
  actions: number;
  /** What its checked record has earned, before work BRYDGE has not seen is taken off. */
  earned: number;
  unseen: { unchecked: number; unestablished: number };
  valueCents: number | null;
  used: { actions: number; valueCents: number };
  remaining: { actions: number; valueCents: number | null };
  typicalAmount: number | null;
  valueBecause: string | null;
  labour: { cents: number; currency: string } | null;
  record: { confirmed: number; contradicted: number; hidden: number; awaitingCheck: number };
  heldBy: "LADDER" | "EVIDENCE" | "ERRORS" | "RECOVERING";
  toNextTier: number;
  raises: string;
  lowers: string;
  says: string;
  unseenSays: string | null;
}

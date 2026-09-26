# @brydge-ai/langchain

Check whether your LangChain agent's work actually happened.

[BRYDGE](https://www.brydge-ai.com) supervises an agent's tool calls. Before a call runs, BRYDGE decides whether the agent may make it. Afterwards, BRYDGE reads the destination system's own records, such as your payment processor or ticket system, using its own credential. It then reports whether the work happened as permitted. What the agent says happened is kept beside that finding and never decides it.

This package connects a LangChain.js agent to BRYDGE:

- **`brydgeMiddleware`** asks BRYDGE before each tool call you list, and records the answer.
- **`authorizationFor`** gives a running tool the id to write into the record it creates, which is how BRYDGE finds the work later.
- **`BrydgeClient.verifyWork`** checks every action in a run.
- **`BrydgeVerifyTool`** lets the agent check its own work before it tells anyone the work is done.

## Install

```bash
npm install @brydge-ai/langchain langchain @langchain/core
```

Requires Node.js 20 or later and `langchain` 1.3 or later.

## Set up BRYDGE first

Do these once, in BRYDGE:

1. **Issue an API key** on the Connect page, and set it as `BRYDGE_API_KEY`.
2. **Declare what the action is worth.** BRYDGE charges a share of that value, and it will not check an action nobody has priced.
3. **Register a destination** for the action: where BRYDGE reads the records, and the read-only credential it uses. BRYDGE has a preset for Stripe refunds.
4. **Issue a mandate** to the agent for the action. Without one, every call goes to a person.

A mandate says what the agent may do; headroom says how much of it, in any 24 hours. A new agent starts with room for one action a day, and every report BRYDGE checks and finds true raises that. Calls beyond it go to a person. `brydge.headroom(actor, action)` shows where an agent stands.

## Quick start

```ts
import Stripe from "stripe";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import { BrydgeClient, authorizationFor, brydgeMiddleware } from "@brydge-ai/langchain";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const brydge = new BrydgeClient(); // reads BRYDGE_API_KEY

const refund = tool(
  async ({ chargeId, amount }, config) => {
    const r = await stripe.refunds.create({
      charge: chargeId,
      amount,
      // BRYDGE finds this refund in Stripe by this id, and by nothing else.
      metadata: { brydge_authorization: authorizationFor(config) },
    });
    return `Refund ${r.id} is ${r.status}.`;
  },
  {
    name: "refund",
    description: "Refund part or all of a charge. The amount is in pence.",
    schema: z.object({ chargeId: z.string(), amount: z.number().int().positive() }),
  },
);

const agent = createAgent({
  model: "anthropic:claude-sonnet-5", // any chat model that can call tools
  tools: [refund],
  middleware: [
    brydgeMiddleware({ client: brydge, actor: "agent:refund-ops", tools: { refund: { target: "chargeId" } } }),
  ],
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Refund £42 on ch_3QxF8c2eZvKYlo2C0mTgQX1b." }],
});

for (const check of await brydge.verifyWork(result.messages)) {
  console.log(check.tool, check.target, check.state, check.because);
}
// refund ch_3QxF8c2eZvKYlo2C0mTgQX1b VERIFIED The destination's books match what BRYDGE authorised.
```

The action is named after the tool (`refund`), so it must match the action you set up in BRYDGE. Use `action` to name it differently.

## What a check can find

| `state`    | Meaning |
| ---------- | ------- |
| `VERIFIED` | The records show the work, as it was permitted. |
| `FAILED`   | The records show it was attempted and did not succeed. |
| `MISMATCH` | The records show something other than what was permitted. `reason` says what: `AMOUNT`, `TARGET`, `ACTOR`, `ACTION`, `DUPLICATE_EXECUTION`, `UNAUTHORISED_EXECUTION` or `CORRELATION`. |
| `UNKNOWN`  | BRYDGE could not tell. `NO_MATCH` means the records hold nothing for this authorization. The other reasons mean BRYDGE could not read the records. Unknown is not the same as failed. |
| `PENDING`  | The destination says the work is still in progress. |

Each finding also carries `claimed`, the outcome the middleware reported for the agent, and `agentAgreed`, which says whether that report survived the records.

## What the middleware does

For each call to a tool listed under `tools`:

1. **Asks BRYDGE first.** It sends the agent (`actor`), the action, the target, the facts and an idempotency key. A retried call gets the same answer; a different call never does.
2. **Allowed:** the tool runs, and `authorizationFor(config)` returns BRYDGE's id for this call. Write it into the record your tool creates.
3. **Escalated:** the tool does not run. The model gets an error message saying a person is deciding, with BRYDGE's reason.
4. **Reports the outcome.** When the tool returns normally, the middleware reports `SUCCEEDED`. When the tool throws or returns an error message, it reports nothing, because a call can fail before it reaches the destination. Use `outcome` to report something else.
5. **Records the call** on the tool's message, under `message.metadata.brydge`. `verifyWork` and `supervisedActions` read it from there.

Tools you do not list run untouched, and BRYDGE hears nothing about them.

### Options

`brydgeMiddleware(options)`

| Option   | Description |
| -------- | ----------- |
| `actor`  | The agent, as BRYDGE knows it, for example `agent:refund-ops`. Mandates are issued to this name. Required. |
| `tools`  | The tools to supervise, keyed by tool name. Required. |
| `client` | A `BrydgeClient`. Defaults to one configured from the environment. |

Each entry in `tools`:

| Field     | Description |
| --------- | ----------- |
| `target`  | What the call acts on: the name of an argument, or a function of the arguments. Required. If the model leaves it out, the tool does not run and the model is asked to call again. |
| `action`  | BRYDGE's name for the action. Defaults to the tool name. |
| `facts`   | A function returning what BRYDGE's mandates judge the call by. Defaults to the call's top-level strings, numbers and booleans. BRYDGE compares a fact named `amount` with the amount in the destination's record, so give both in the same units. |
| `outcome` | A function from the tool's result to the outcome to report, or `null` to report nothing. |

## Let the agent check its own work

Add `BrydgeVerifyTool` to the agent's tools. When the model calls it, BRYDGE checks the actions carried out earlier in the same run. The model cannot pass anything that changes a finding.

```ts
import { BrydgeVerifyTool } from "@brydge-ai/langchain";

const agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [refund, new BrydgeVerifyTool({ client: brydge })],
  middleware: [brydgeMiddleware({ client: brydge, actor: "agent:refund-ops", tools: { refund: { target: "chargeId" } } })],
  systemPrompt: "After you act, check your work with brydge_verify_work before you say it is done.",
});
```

## When to check

`verifyWork`, `verify` and `BrydgeVerifyTool` read the destination's records at the moment you call them. Each call that finds something new is a billed check. Asking again when nothing has changed returns the same finding at no charge.

BRYDGE also checks every action by itself once the destination's reporting window has passed, which is 60 minutes unless you set another. You can read that finding for free:

```ts
const finding = await brydge.finding(authorization); // PENDING until BRYDGE has looked
```

If your destination records work some time after the call returns, check after it has. A check that finds nothing is compared with what the agent reported. If the records catch up later, check again: the newer finding for the same report stands.

## When BRYDGE cannot be asked

If BRYDGE cannot give an answer (a bad key, an action with no declared value, a rate limit, or BRYDGE being unreachable), the tool does not run and the agent run fails with the reason. The middleware does not catch or change errors from the tool itself.

LangChain wraps errors raised by middleware in its own `MiddlewareError`. Use `BrydgeError.find` to get BRYDGE's error back:

```ts
import { BrydgeError } from "@brydge-ai/langchain";

try {
  await agent.invoke(input);
} catch (error) {
  const refused = BrydgeError.find(error);
  if (refused?.status === 402) console.error(refused.message); // for example, no value declared
  else throw error;
}
```

To let the model see the problem instead, put LangChain's `toolErrorMiddleware` (in `langchain` 1.5.4 and later) before `brydgeMiddleware`:

```ts
import { toolErrorMiddleware } from "langchain";

middleware: [
  toolErrorMiddleware({
    onError: (error) => (BrydgeError.find(error) ? "Not done: BRYDGE could not be asked. Try again later." : undefined),
  }),
  brydgeMiddleware({ client: brydge, actor: "agent:refund-ops", tools: { refund: { target: "chargeId" } } }),
],
```

## Client

```ts
const brydge = new BrydgeClient({
  apiKey: "brydge_sk_…", // default: BRYDGE_API_KEY
  baseUrl: "https://…",  // default: BRYDGE_URL, then BRYDGE's hosted service
  timeoutMs: 30_000,     // default
});

await brydge.supervise({ actor, action, target, facts, idempotencyKey }); // ask before acting
await brydge.report(authorization, "SUCCEEDED");                         // what the agent says happened
await brydge.verify(authorization);                                      // read the records now
await brydge.finding(authorization);                                     // what BRYDGE has found so far, free
await brydge.headroom(actor, action);                                    // how much the agent may do without a person today
await brydge.verifyWork(result.messages);                                // check every action in a run
```

The client sends your key only over https, except to `localhost`.

## Limits

- BRYDGE treats a target as one piece of work. A second record for the same target that carries a different authorization, such as a second partial refund of one charge, is reported as a `MISMATCH`.
- The middleware does not wait for a person. An escalated call ends as a message to the model, and a later call is a new request that BRYDGE decides again.
- A tool that returns a LangGraph `Command` is supervised and reported, but not recorded on a message, so `verifyWork` does not see it. Check it with `brydge.verify(id)`, using the id from `authorizationFor(config)`.
- The record of each call lives on its tool message. If you trim or summarize messages, check the run first.

## Development

```bash
npm install
npm test          # unit tests: a real LangChain agent against BRYDGE's API, answered in memory
npm run test:int  # against a running BRYDGE; see tests/integration_tests
npm run build
```

## License

MIT

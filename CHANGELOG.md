# Changelog

## 0.2.0

A person's answer now reaches the agent. Needs BRYDGE as it runs from 2 October 2026, which the hosted service does.

- **A retry asks under the same idempotency key.** The key names the action where it lives and by what is asked: the conversation's `thread_id` (or, without one, the run), the actor, the action, the target and the facts. Before, each tool call had a key of its own, so a model calling the tool again made a fresh request, which BRYDGE escalated again; the person's answer to the first never reached the agent.
- **Approvals reach the agent.** Once a person allows an escalated call, the same call made again goes ahead, once, under the same authorization. Once they refuse it, the model is told a person refused it, and why.
- **The escalation message** tells the model to call the tool again with the same arguments once a person has answered.
- **One authorization, one execution.** A call made again after it already ran gets the same authorization back, and the tool does not run a second time: the model is told it was already done. Two identical calls made at once run once. A call that failed can be tried again.
- **New `key` option** on a supervised tool names the action yourself, such as `` (args) => `refund:${args.chargeId}` ``, so the same call is the same action in every thread and every process.
- `Supervision` carries `settled` (a person's answer) and `next` (what to do while there is none).
- The quick start gives Stripe the authorization as its idempotency key too.
- Keys from 0.1.x are not carried over: an escalation asked under 0.1.x is asked afresh under 0.2.0.

## 0.1.1

- The README names the package as it is published, `brydge-langchain`.

## 0.1.0

First release.

- `brydgeMiddleware` for LangChain 1.x agents. It asks BRYDGE before each listed tool call, runs the tool only when BRYDGE allows it, reports the outcome, and records the call on the tool's message.
- `authorizationFor`, so a tool can cite BRYDGE's authorization in the record it creates at the destination.
- `BrydgeClient`: `supervise`, `report`, `verify`, `finding`, `headroom` and `verifyWork`.
- `BrydgeVerifyTool`, so an agent can check its own work before it says the work is done.
- `BrydgeError`, with `BrydgeError.find` to recover it from LangChain's `MiddlewareError`.

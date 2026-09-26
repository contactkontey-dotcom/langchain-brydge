# Changelog

## 0.1.0

First release.

- `brydgeMiddleware` for LangChain 1.x agents. It asks BRYDGE before each listed tool call, runs the tool only when BRYDGE allows it, reports the outcome, and records the call on the tool's message.
- `authorizationFor`, so a tool can cite BRYDGE's authorization in the record it creates at the destination.
- `BrydgeClient`: `supervise`, `report`, `verify`, `finding`, `headroom` and `verifyWork`.
- `BrydgeVerifyTool`, so an agent can check its own work before it says the work is done.
- `BrydgeError`, with `BrydgeError.find` to recover it from LangChain's `MiddlewareError`.

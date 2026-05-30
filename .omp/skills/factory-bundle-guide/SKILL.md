---
name: factory-bundle-guide
description: Lex-specific routing guide for choosing factory bundles and repo-local specialist agents.
---

# Lex Factory Bundle Guide

Use this guide when choosing workflow bundles or specialist agents in `lex`.

## Default bundles
- `factory-runtime-control`
- `factory-migrations`
- `factory-incidents`

## Lex/Pi-only bundle
- `factory-autonomous-control` — only when using `omp` / Lex runtime with visible pane and observer support

## Best repo-local agents
- `actor-runtime-auditor`
- `provider-boundary-guardian`

## Examples

### Runtime refactor
```text
Use factory-runtime-control for this task. Let actor-runtime-auditor inspect mailbox/job/observer behavior and escalate race conditions.
```

### Provider boundary change
```text
Use provider-boundary-guardian before touching opencode-antigravity request-shape logic.
```

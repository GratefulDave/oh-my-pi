# Tier B Conflict Surface

## 3ea4981ee
fix(ai): updated google vertex model catalog

```
Files touched upstream:
packages/ai/CHANGELOG.md
packages/ai/scripts/generate-models.ts
packages/ai/src/models.json
packages/ai/src/provider-models/google.ts
packages/ai/src/provider-models/openai-compat.ts
packages/ai/src/providers/google-vertex.ts
packages/ai/src/stream.ts
packages/ai/src/utils/discovery/index.ts
packages/ai/src/utils/discovery/vertex.ts
packages/ai/test/google-vertex-discovery.test.ts

Fork status of those paths:
  packages/ai/CHANGELOG.md  (fork commits touching: 613)
  packages/ai/scripts/generate-models.ts  (fork commits touching: 89)
  packages/ai/src/models.json  (fork commits touching: 93)
  packages/ai/src/provider-models/google.ts  (fork commits touching: 1)
  packages/ai/src/provider-models/openai-compat.ts  (fork commits touching: 67)
  packages/ai/src/providers/google-vertex.ts  (fork commits touching: 29)
  packages/ai/src/stream.ts  (fork commits touching: 108)
  packages/ai/src/utils/discovery/index.ts  (fork commits touching: 2)
  packages/ai/src/utils/discovery/vertex.ts  (MISSING in fork)
  packages/ai/test/google-vertex-discovery.test.ts  (MISSING in fork)
```

## e8b510160
fix(ai): routed vertex claude through raw predict

```
Files touched upstream:
packages/ai/src/models.json
packages/ai/src/provider-models/openai-compat.ts
packages/ai/src/providers/google-vertex.ts
packages/ai/src/stream.ts
packages/ai/test/google-vertex-discovery.test.ts
packages/ai/test/stream.test.ts

Fork status of those paths:
  packages/ai/src/models.json  (fork commits touching: 93)
  packages/ai/src/provider-models/openai-compat.ts  (fork commits touching: 67)
  packages/ai/src/providers/google-vertex.ts  (fork commits touching: 29)
  packages/ai/src/stream.ts  (fork commits touching: 108)
  packages/ai/test/google-vertex-discovery.test.ts  (MISSING in fork)
  packages/ai/test/stream.test.ts  (fork commits touching: 56)
```

## ac7f6e4d1
fix(ai): added vertex anthropic_version to rawPredict bodies

```
Files touched upstream:
packages/ai/src/stream.ts
packages/ai/test/stream.test.ts

Fork status of those paths:
  packages/ai/src/stream.ts  (fork commits touching: 108)
  packages/ai/test/stream.test.ts  (fork commits touching: 56)
```

## 6491fff8f
feat(ai): added strict auth-gateway mode with completion-probe checks

```
Files touched upstream:
packages/ai/CHANGELOG.md
packages/ai/src/auth-storage.ts
.../ai/test/auth-storage-check-credentials.test.ts
packages/coding-agent/src/cli/auth-gateway-cli.ts
packages/coding-agent/src/commands/auth-gateway.ts

Fork status of those paths:
  packages/ai/CHANGELOG.md  (fork commits touching: 613)
  packages/ai/src/auth-storage.ts  (fork commits touching: 72)
  .../ai/test/auth-storage-check-credentials.test.ts  (MISSING in fork)
  packages/coding-agent/src/cli/auth-gateway-cli.ts  (fork commits touching: 4)
  packages/coding-agent/src/commands/auth-gateway.ts  (fork commits touching: 2)
```

## 3d5f0d886
refactor(coding-agent/cli): switched auth-broker serve to dedicated logger transport setter

```
Files touched upstream:
packages/coding-agent/src/cli/auth-broker-cli.ts

Fork status of those paths:
  packages/coding-agent/src/cli/auth-broker-cli.ts  (fork commits touching: 6)
```

## c0c9049cc
fix(mcp): bounded optional http sse startup

```
Files touched upstream:
packages/coding-agent/src/mcp/transports/http.ts
.../coding-agent/test/mcp-http-transport.test.ts

Fork status of those paths:
  packages/coding-agent/src/mcp/transports/http.ts  (fork commits touching: 16)
  .../coding-agent/test/mcp-http-transport.test.ts  (MISSING in fork)
```

## 2266fdae8
fix(mcp): honor disabled mcp timeouts for sse startup

```
Files touched upstream:
packages/coding-agent/src/mcp/transports/http.ts
.../coding-agent/test/mcp-http-transport.test.ts

Fork status of those paths:
  packages/coding-agent/src/mcp/transports/http.ts  (fork commits touching: 16)
  .../coding-agent/test/mcp-http-transport.test.ts  (MISSING in fork)
```

## b4238b10d
fix: resolved auth-gateway handling of 429 usage-limit responses

```
Files touched upstream:
packages/ai/CHANGELOG.md
packages/ai/src/auth-gateway/server.ts
packages/ai/src/stream.ts
.../ai/test/auth-gateway-classify-error.test.ts
packages/ai/test/google-gemini-cli-429.test.ts
packages/ai/test/stream-auth-retry.test.ts
packages/coding-agent/CHANGELOG.md
packages/coding-agent/src/sdk.ts
packages/utils/src/fetch-retry.ts

Fork status of those paths:
  packages/ai/CHANGELOG.md  (fork commits touching: 613)
  packages/ai/src/auth-gateway/server.ts  (fork commits touching: 5)
  packages/ai/src/stream.ts  (fork commits touching: 108)
  .../ai/test/auth-gateway-classify-error.test.ts  (MISSING in fork)
  packages/ai/test/google-gemini-cli-429.test.ts  (fork commits touching: 3)
  packages/ai/test/stream-auth-retry.test.ts  (fork commits touching: 2)
  packages/coding-agent/CHANGELOG.md  (fork commits touching: 1982)
  packages/coding-agent/src/sdk.ts  (fork commits touching: 211)
  packages/utils/src/fetch-retry.ts  (fork commits touching: 5)
```

## 6fb1983fb
fix: add EventLoopKeepalive to Agent.prompt()

```
Files touched upstream:
packages/agent/src/agent.ts

Fork status of those paths:
  packages/agent/src/agent.ts  (fork commits touching: 78)
```

## e46ee155a
fix(coding-agent): shared Python kernels between eval and user shortcut - Namespaced `AgentSession.executePython()` session IDs before invoking the Python executor. - Added a regression test proving eval state is visible to the user shortcut path.

```
Files touched upstream:
packages/coding-agent/CHANGELOG.md
packages/coding-agent/src/eval/py/index.ts
packages/coding-agent/src/session/agent-session.ts
.../test/agent-session-user-shortcut-hooks.test.ts

Fork status of those paths:
  packages/coding-agent/CHANGELOG.md  (fork commits touching: 1982)
  packages/coding-agent/src/eval/py/index.ts  (fork commits touching: 5)
  packages/coding-agent/src/session/agent-session.ts  (fork commits touching: 317)
  .../test/agent-session-user-shortcut-hooks.test.ts  (MISSING in fork)
```

## af2011f5a
fix: use inline setInterval instead of EventLoopKeepalive import

```
Files touched upstream:
packages/agent/src/agent.ts

Fork status of those paths:
  packages/agent/src/agent.ts  (fork commits touching: 78)
```

## 674d9b00a
fix(codex): prefer gpt-5.5 for web search

```
Files touched upstream:
.../coding-agent/src/web/search/providers/codex.ts
.../test/tools/web-search-codex.test.ts

Fork status of those paths:
  .../coding-agent/src/web/search/providers/codex.ts  (MISSING in fork)
  .../test/tools/web-search-codex.test.ts  (MISSING in fork)
```

## c1fa0e9f5
refactor(agent): replaced keepalive utility with disposable EventLoopKeepalive

```
Files touched upstream:
packages/agent/src/agent.ts
packages/agent/src/utils/yield.ts
packages/coding-agent/src/main.ts
.../coding-agent/src/modes/interactive-mode.ts

Fork status of those paths:
  packages/agent/src/agent.ts  (fork commits touching: 78)
  packages/agent/src/utils/yield.ts  (MISSING in fork)
  packages/coding-agent/src/main.ts  (fork commits touching: 239)
  .../coding-agent/src/modes/interactive-mode.ts  (MISSING in fork)
```

## 5053a6a4d
fix(coding-agent): corrected coding-agent incomplete stop recovery logic

```
Files touched upstream:
.../src/extensibility/custom-tools/types.ts
.../src/extensibility/shared-events.ts
packages/coding-agent/src/internal-urls/index.ts
packages/coding-agent/src/internal-urls/router.ts
.../src/internal-urls/vault-protocol.ts
.../src/modes/controllers/event-controller.ts
.../src/prompts/system/system-prompt.md
packages/coding-agent/src/session/agent-session.ts
.../test/agent-session-context-promotion.test.ts
.../test/internal-urls/vault-protocol.test.ts

Fork status of those paths:
  .../src/extensibility/custom-tools/types.ts  (MISSING in fork)
  .../src/extensibility/shared-events.ts  (MISSING in fork)
  packages/coding-agent/src/internal-urls/index.ts  (fork commits touching: 16)
  packages/coding-agent/src/internal-urls/router.ts  (fork commits touching: 16)
  .../src/internal-urls/vault-protocol.ts  (MISSING in fork)
  .../src/modes/controllers/event-controller.ts  (MISSING in fork)
  .../src/prompts/system/system-prompt.md  (MISSING in fork)
  packages/coding-agent/src/session/agent-session.ts  (fork commits touching: 317)
  .../test/agent-session-context-promotion.test.ts  (MISSING in fork)
  .../test/internal-urls/vault-protocol.test.ts  (MISSING in fork)
```


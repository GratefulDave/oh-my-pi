# Tier C Group V: Vertex Claude rawPredict Architecture

**Status**: Read-only discovery. Fork ALREADY contains upstream rawPredict commits.

## Fork vs. Upstream State

| Aspect | Fork (parity/upstream-15.5.9-tierA) | Upstream |
|--------|------|----------|
| **Commits** | ac7f6e4d1, e8b510160, 3ea4981ee present | Base state (analyzed) |
| **rawPredict helpers** | ✓ Present in stream.ts | ✓ Added in ac7f6e4d1 |
| **Vertex Claude routing** | ✓ isVertexAnthropicRawPredict, transformVertexAnthropicBody | ✓ Same |
| **anthropic_version injection** | ✓ Present (vertex-2023-10-16) | ✓ Same |
| **Catalog refresh (models.json)** | Older: 27 Vertex entries, no MaaS DeepSeek, Gemini 1.5 present | Updated: drop Gemini 1.5, add MaaS DeepSeek |

## Upstream Commits (3ea4981ee → ac7f6e4d1)

### 3ea4981ee: Catalog Refresh
- **Files**: models.json (+1022 -513), provider-models/google.ts, stream.ts, utils/discovery/vertex.ts (DELETED)
- **Changes**: Replaced project discovery with models.dev catalog; dropped retired Gemini fallbacks; added MaaS DeepSeek entries
- **Vertex count**: Pre-refresh baseline (project discovery removed)

### e8b510160: rawPredict Routing
- **File**: stream.ts (+27 -13)
- **Helpers added**:
  - `isGoogleVertexAuthenticatedModel()` — checks for `/endpoints/openapi` OR `:streamRawPredict`
  - `createVertexAuthenticatedFetch()` — wraps baseFetch with Bearer token + URL rewrite
  - `resolveVertexRequest()` — rewrites `{project}` and `{location}` placeholders; handles URL-encoded `%7B`/`%7D`; rewrites `:streamRawPredict/v1/messages` → `:streamRawPredict`

### ac7f6e4d1: Anthropic Body Transform
- **File**: stream.ts (+41 -1)
- **New helpers**:
  - `isVertexAnthropicRawPredict()` — detects `:streamRawPredict` or `:rawPredict` in URL
  - `readVertexRequestBody()` — extracts body from Request, string, Uint8Array, ArrayBuffer
  - `transformVertexAnthropicBody()` — **key logic**: deletes `model` field, injects `anthropic_version: "vertex-2023-10-16"` (Vertex expects this in body, not HTTP header)
- **Intercept point**: Inside `createVertexAuthenticatedFetch()` before baseFetch call

## Fork Architecture Status

**google-vertex dispatch**:
- Route: `model.api === "google-vertex"` → `streamGoogleVertex()`
- Provider: `packages/ai/src/providers/google-vertex.ts`
- Current: Uses `streamGoogleGenAI()` wrapper; handles Gemini-only; **does NOT route anthropic-messages**

**No Vertex Claude entries detected in fork's models.json** yet (fork still on 27 Vertex entries, all Gemini).

**stream.ts**:
- Fork has: GoogleVertexOptions import, streamGoogleVertex dispatch
- Fork **lacks**: isVertexAnthropicRawPredict, transformVertexAnthropicBody, readVertexRequestBody (rawPredict helpers)
- Comment on line 202: "vertex-claude-api" custom API registry reference (unused)

## Port Strategy Recommendation

### Option A: Adopt Upstream fetch-wrapper Arch
Requires:
1. Add rawPredict helpers (isVertexAnthropicRawPredict, readVertexRequestBody, transformVertexAnthropicBody) to stream.ts
2. Rename `isGoogleVertexOpenAIModel()` → `isGoogleVertexAuthenticatedModel()` (checks both `/endpoints/openapi` + `:streamRawPredict`)
3. Rename `createVertexOpenAIFetch()` → `createVertexAuthenticatedFetch()` (wraps both OpenAI-compat + Anthropic rawPredict)
4. Update dispatch logic: `isGoogleVertexAuthenticatedModel()` check wraps both Gemini OpenAI paths AND new Claude rawPredict paths
5. Add Vertex Claude catalog entries to models.json

**Diff size**: ~80 LOC in stream.ts + models.json updates
**Compatibility**: Fork's google-vertex dispatch remains unchanged; only stream.ts fetch logic updated

### Option B: Fold rawPredict into streamGoogleVertex
Requires:
1. Detect `api === "anthropic-messages"` + `provider === "google-vertex"` in main stream() switch
2. New case: route to modified `streamGoogleVertex()` or new `streamGoogleVertexClaude()` helper
3. Inside handler: inject rawPredict URL rewrite + anthropic_version transform
4. Add Vertex Claude catalog entries

**Diff size**: ~50 LOC in stream.ts + google-vertex.ts + models.json updates
**Compatibility**: Preserves fork's provider-dispatch separation; keeps rawPredict logic in Vertex provider

### Option C: Catalog Refresh Only
1. Cherry-pick models.json delta from 3ea4981ee (drop Gemini 1.5, add MaaS DeepSeek)
2. Skip rawPredict routing logic

**Diff size**: models.json only (~500 LOC)
**Limitation**: No Vertex Claude support; Gemini roadmap incomplete

## Recommendation

**Option A (upstream fetch-wrapper)**: Best architectural fit.

**Reasoning**:
- Fork already imports & dispatches `streamGoogleVertex` — adding rawPredict support via fetch wrapper is an **incremental enhancement**, not a redesign
- Fetch wrapper is **provider-agnostic**: stream.ts remains the routing hub; no new provider code needed
- Models.json entries become self-describing: `api: "anthropic-messages", provider: "google-vertex", baseUrl: ":streamRawPredict"` is declarative
- Upstream design is proven; sync effort minimal (~80 LOC)
- Aligns fork with upstream direction post-Tier C

**Next**: Port 3ea4981ee catalog delta + ac7f6e4d1/e8b510160 stream.ts helpers. Catalog refresh is orthogonal—can land independently.

# SuperGrok (`xai-oauth`) tool-call failures

Date: 2026-08-21
Lane: lex `upstream-17.4.2` (`f1c082c4b6` plus local P12)
Upstream: [PR #8617](https://github.com/can1357/oh-my-pi/pull/8617) still OPEN; [issue #8698](https://github.com/can1357/oh-my-pi/issues/8698) `wontfix`

## Short answer

**Nothing in omp/lex sets `parallel_tool_calls: false` for SuperGrok.**

There is no `config.yml` / settings-schema key. `buildParams` used to **omit** the field. The only place this repo writes `parallel_tool_calls = false` is Codex `responsesLite` (`packages/ai/src/providers/openai-codex/request-transformer.ts`), which SuperGrok does not use.

What SuperGrok saw on the wire (before the local fix):

```json
{ "model": "grok-4.6", "tools": [ ... ] }
```

No `parallel_tool_calls` key.

## Who sets the flag

| Writer | Value | Applies to SuperGrok? |
|---|---|---|
| `openai-responses.ts` `buildParams` (pre-P12) | **omitted** | yes — this was the live path |
| `openai-responses.ts` `buildParams` (P12, now) | `true` if `provider === "xai-oauth"` and tools exist | yes |
| Codex `responsesLite` transformer | `false` | no |
| Anthropic inbound server (`disable_parallel_tool_use`) | `parallelToolCalls = false` | no — inbound Anthropic compat only |
| `~/.omp/agent/config.yml` / settings schema | does not exist | n/a |

OpenAI's Responses create-params type (`openai-responses-wire.ts`) marks the field optional (`boolean | null`). Omit = "let the host decide."

## What the host does with omit

Two stories, both need stating:

**Public xAI docs (2026-07-14)** — [Function Calling](https://docs.x.ai/developers/tools/function-calling):

> By default, parallel function calling is enabled. Disable with `parallel_tool_calls: false`.

**Observed SuperGrok / `xai-oauth` behavior** (issue #8698, 2026-08-16, after those docs):

When the client omits the field, SuperGrok behaves as if parallel is **off**: it emits several `function_call`s but only the first is streamed as `output_item.added` / `done`. The rest appear only on the terminal `response.completed.output`. A spec-faithful decoder that only follows streamed item events therefore runs one tool and the model reprints the rest as prose (`<task>`, `<command>`, …).

Paid `xai` (API key) and OpenRouter Grok do not show this. The OAuth / SuperGrok product is a different serving path than the documented paid Responses default.

So: **not an omp setting.** Either SuperGrok's omit-default is still `false` despite the docs, or parallel is "on" but the stream still only emits the first item (same user-visible failure). Sending `parallel_tool_calls: true` is the client-side way to stop leaving it to that host.

## The other SuperGrok wire bugs (not the flag)

These happen even after the flag is true. They are why #8617 is more than one line.

1. **Later parallel calls exist only on `response.completed.output`.** HEAD decoder (`processResponsesStream`) finalized streamed items and ignored extra terminal `function_call`s. Fix: `harvestResponsesTerminalOutputToolCalls` for `xai-oauth` only.
2. **Completions-shaped chunks on a Responses SSE.** SuperGrok sometimes sends `object: "chat.completion.chunk"` with `choices[].delta.tool_calls`, sometimes with **no** `response.completed`. HEAD treated that as not-a-tool → `stop`. Fix: `ingestXaiOauthCompletionsShapedToolCalls` + post-loop finalize.
3. **Root exclusive-required `anyOf` 400.** MCP tools shaped "pass `paths` OR `scopes`" 400 the whole turn (`tool parameter root must be an object type`). Already flattened on HEAD for `xai` + `xai-oauth` (`flattenExclusiveRequiredRootUnion`). Nested unions stay intact.
4. **`<command>` text is never parsed.** xai-oauth is `api: openai-responses`. Tool calls become `toolUse` only from structured `function_call` / Completions `tool_calls`. `output_text.delta` is visible text. No grok/`<command>` dialect exists. #8617 does not add one.

## Local fix (fork patch P12)

Kept here because upstream marked the host bugs `wontfix` and #8617 may never land.

| File | Change |
|---|---|
| `packages/ai/src/providers/openai-responses.ts` | `params.parallel_tool_calls = true` when `model.provider === "xai-oauth"` and tools exist |
| `packages/ai/src/providers/openai-shared.ts` | harvest terminal `function_call`s; ingest Completions-shaped chunks; finalize if no Responses terminal |
| `packages/ai/test/openai-responses-stream-terminal.test.ts` | harvest / no-harvest (OpenAI, OpenRouter, paid xAI) / Completions ingest / no-terminal finalize |
| `packages/ai/test/openai-responses-tool-quarantine.test.ts` | asserts xai-oauth sets the flag; others leave it unset |
| `docs/upstream-rebase-and-fork-maintenance.md` | Patch 12 |
| `../lex-maintenance/scripts/check-fork-patches.ts` | `P12` |

Paid `xai`, OpenAI, Azure, Codex, OpenRouter: still omit the flag.

## Verify

```bash
bun test packages/ai/test/openai-responses-stream-terminal.test.ts \
         packages/ai/test/openai-responses-tool-quarantine.test.ts \
         -t "harvests parallel|does not harvest|ingests Completions|finalizes Completions|parallel_tool_calls"
```

10 pass (2026-08-21). Full stream-terminal file: 35/35.

Installed `omp`/`lex` is still **17.4.2** until `./rebuild-lex.zsh` finishes. This session's process will not see the decoder until then. Cargo lock from other trees blocked two rebuilds.

## What we did not do

- No `<command>` XML decoder (no wire sample; would be a second protocol on Responses).
- No change to Codex `responsesLite` (`parallel_tool_calls = false` stays there).
- Did not "fix" the pre-existing OpenAI test `preserves an exclusive-required MCP tool on OpenAI Responses` — fails on stock HEAD too.
- Did not comment on or merge #8617.
.from_the_user. I'll write the file now. The write was aborted because I put extra text after the function call. Let me just write the file.0/write
# System Prompt Token Optimization

This document reviews where the coding-agent system prompt spends context and lists token-saving changes that preserve behavior. It is an audit and planning guide; it does not imply these optimizations are already implemented.

## Current assembly path

Primary code paths:

- `packages/coding-agent/src/system-prompt.ts`
  - `buildSystemPromptToolMetadata()` copies each active tool's label, description, schema, examples, and wire name into prompt metadata.
  - `buildSystemPrompt()` renders the provider-facing system prompt blocks.
- `packages/coding-agent/src/prompts/system/system-prompt.md`
  - Stable base instructions: role, skills/rules lists, internal URLs, tool policy, workflow, delivery contract, personality.
- `packages/coding-agent/src/prompts/system/project-prompt.md`
  - Dynamic project block: workstation, context files, dir-context pointers, optional workspace tree, date/cwd, appended instructions.
- `packages/coding-agent/src/sdk.ts`
  - `rebuildSystemPrompt()` adds memory instructions, auto-learn guidance, MCP server instructions, active tool metadata, rulebook rules, context files, and settings-driven options.
- `packages/coding-agent/src/session/agent-session.ts`
  - Prompt rebuild skip logic compares a signature of active tool names, labels, descriptions, wire names, discoverable-tool data, MCP server instructions, and date. This protects prompt-cache stability when tools reconnect without changing bytes.

Rendered prompt shape from `buildSystemPrompt()`:

1. Block 0: `system-prompt.md` or `custom-system-prompt.md`.
2. Block 1: `project-prompt.md` when non-empty.
3. Block 2: active repo context when present.

Important defaults and gates:

- `inlineToolDescriptors` defaults to `false`.
- `nativeTools` defaults to `true`.
- With native tool calling and no inline descriptors, `toolListMode` renders a compact active-tool list in block 0 instead of full `# Tool:` sections.
- `includeWorkspaceTree` defaults to `false`, so workspace tree is not a default cost.
- MCP server instructions are appended after memory/auto-learn instructions and truncated at 4,000 characters per server in `sdk.ts`.
- Skills are injected as metadata only (`name: description`) when the `read` tool is available; full skill content is loaded on demand via `skill://...`.
- Always-apply rules inject full content after dedupe; normal rulebook rules inject name, globs, and description only.

## Static prompt-size findings

Measurement commands used:

- `bun scripts/tool-prompt-usage.ts --json` for rendered tool prompt templates, `o200k_base`.
- A local JS metric over `.md` prompt files for static byte/line/token estimates using `ceil(chars / 4)` where no repo estimator exists.

Static prompt-file estimate by area:

| Area | Files | Approx tokens | Largest files |
|---|---:|---:|---|
| `packages/coding-agent/src/prompts/system` | 61 | 20,077 | `system-prompt.md` 3,594; `plan-mode-active.md` 2,539; `workflow-notice.md` 2,178; `orchestrate-notice.md` 1,377 |
| `packages/coding-agent/src/prompts/tools` | 41 | 15,240 static; 13,914 rendered by estimator | `eval.md`, `browser.md`, `read.md`, `task.md`, `bash.md` |
| `packages/coding-agent/src/prompts/agents` | 9 | 8,673 | `tester.md` 3,099; `librarian.md` 1,382; `reviewer.md` 1,376 |
| `packages/hashline/src/prompt.md` | 1 | 1,932 | edit/hashline grammar |
| `packages/coding-agent/src/prompts/skills` | 2 | 145 | small |

Largest static prompt files observed:

| File | Approx tokens | Lines |
|---|---:|---:|
| `packages/coding-agent/src/prompts/system/system-prompt.md` | 3,594 | 249 |
| `packages/coding-agent/src/prompts/agents/tester.md` | 3,099 | 112 |
| `packages/coding-agent/src/prompts/system/plan-mode-active.md` | 2,539 | 119 |
| `packages/coding-agent/src/prompts/system/workflow-notice.md` | 2,178 | 71 |
| `packages/hashline/src/prompt.md` | 1,932 | 173 |
| `packages/coding-agent/src/prompts/tools/eval.md` | 1,662 static / 1,336 rendered | 73 static / 66 rendered |
| `packages/coding-agent/src/prompts/system/orchestrate-notice.md` | 1,377 | 41 |
| `packages/coding-agent/src/prompts/tools/task.md` | 1,261 static / 838 rendered | 69 static / 53 rendered |
| `packages/coding-agent/src/prompts/tools/browser.md` | 1,233 static / 1,357 rendered | 46 static / 45 rendered |

The static directory totals are not equal to every session's live prompt. They identify the available prompt surface and major contributors. Live cost depends on active tools, model dialect, skills enabled, context files loaded, MCP servers connected, memory backend, task/eager settings, rules, and workspace tree setting.

## High-cost live sources

### 1. Base system prompt

`system-prompt.md` carries broad behavioral policy. It repeats rules in multiple forms:

- tool policy;
- exploration workflow;
- execution workflow;
- delivery contract;
- completeness contract;
- evidence/output contract;
- yielding checklist;
- personality rules.

Many clauses are intentionally scar tissue. Do not delete lines only because they sound redundant. Use `git blame` before pruning any rule.

Optimization candidates:

- Collapse repeated global absolutes into one canonical contract section.
- Move infrequently needed policy detail behind named internal URLs, then keep only the routing trigger in the system prompt.
- Use mode-specific compact prompt variants for reviewer-only, planner-only, answer-only, and no-edit sessions.
- Keep only the minimum always-on safety/workflow invariants in block 0.

### 2. Project context files

`project-prompt.md` inlines loaded context files verbatim. In this repo, the loaded `AGENTS.md` plus user-level rules can be much larger than the base prompt itself.

Optimization candidates:

- Split context files into:
  - always-on compact summary;
  - on-demand sections addressable through internal URLs;
  - path-scoped rules loaded only when the active file path matches.
- Hash and cache context file summaries, then inject only changed sections.
- Add per-context-file budgets and overflow links.
- Add a rule severity marker: `critical`, `routing`, `style`, `reference`. Inject `critical` and `routing` by default; defer `style` and `reference` until relevant.

Risk:

- Repo rules prevent real failures. Summary must keep exact hard bans, command rules, and generated-file rules.

### 3. Skills metadata

Skills are already better than fully inline docs: only name + description enter block 0 and full content is available through `skill://...` reads. The cost grows with number and verbosity of discovered skill descriptions.

Optimization candidates:

- Cap always-listed skills by relevance to the current prompt; keep all skills searchable through a skill index.
- Shorten skill descriptions to trigger phrases plus one-line purpose.
- Use a two-tier list: always-on core skills; hidden/searchable long tail.
- Deduplicate synonyms across skill descriptions because the model only needs routing cues.

Risk:

- If a skill trigger disappears from block 0, the model may fail to load required instructions. Keep explicit trigger phrases.

### 4. Rulebook and always-apply rules

Normal rulebook rules inject compact metadata. `alwaysApplyRules` inject full content after dedupe.

Optimization candidates:

- Prefer rule summaries plus `rule://...` detail unless the rule is a hard safety invariant.
- Convert long always-apply rules into path-scoped rules where possible.
- Add a token budget per always-apply source and emit overflow as a link.
- Normalize duplicate phrasing across global rule files before injection.

Risk:

- Rules that change tool choice or safety behavior are load-bearing. Keep them inline if missing them causes harmful tool use.

### 5. MCP server instructions

MCP instructions are server-controlled and appended under `## MCP Server Instructions`. Current truncation is character-based at 4,000 chars per server.

Optimization candidates:

- Replace raw server instructions with a generated routing card: server name, tool families, auth/safety caveats, docs URL/link to full text.
- Deduplicate repeated boilerplate across MCP servers.
- Use per-server change hashes so unchanged server instructions do not perturb prompt cache.
- Keep full instructions addressable by internal URL or tool discovery result.

Risk:

- Server instructions can include mandatory safety or parameter rules. Summarization needs an allowlist of non-droppable phrases (`MUST`, `NEVER`, auth, destructive, billing, external side effect).

### 6. Mode notices and agents

Large prompts include `plan-mode-active.md`, `workflow-notice.md`, `orchestrate-notice.md`, and bundled agent prompts. These should only enter turns that need those modes.

Optimization candidates:

- Validate that mode prompts are never included outside their mode.
- Split long mode prompts into short runtime card + on-demand reference.
- Use agent prompt profiles: full prompt at first spawn, compact prompt for repeated same-role spawns in same session.
- Keep only agent name + short description in the `task` tool; load full agent instruction only inside subagent session.

## Recommended optimization plan

### Phase 1: Instrument before cutting

Add or extend measurements so every prompt build can report:

- block 0 tokens;
- project context tokens;
- active repo context tokens;
- tool schema tokens;
- skill metadata tokens;
- rules tokens;
- MCP instruction tokens;
- append/memory/autolearn tokens;
- active tool count and discoverable tool count.

Existing code already has `computeNonMessageBreakdown()` in `packages/coding-agent/src/modes/utils/context-usage.ts` with broad categories:

- `systemPromptTokens`;
- `systemContextTokens`;
- `toolsTokens`;
- `skillsTokens`.

Next useful step is subcategory attribution inside prompt construction, not only after concatenation.

### Phase 2: Preserve prompt-cache stability

Do not optimize by changing prompt bytes every turn. Prompt caching matters for Anthropic and other providers.

Keep or strengthen current behavior:

- avoid prompt rebuild when active tool signature is identical;
- keep tool order stable;
- keep generated summaries deterministic;
- hash dynamic sections and reuse exact bytes when source content is unchanged;
- isolate date changes so only required sessions refresh at midnight.

### Phase 3: Split always-on vs on-demand content

Rule of thumb:

- Inline only instructions that change the next tool choice or prevent irreversible damage.
- Link or lazy-load reference detail, examples, long grammars, mode manuals, and external API docs.

Suggested split:

| Content | Inline default | On demand |
|---|---|---|
| hard safety and completion contract | yes | no |
| tool routing one-liners | yes | full tool manual |
| skill names + trigger phrases | yes | full skill body |
| context-file hard bans | yes | full context file |
| MCP server safety/auth caveats | yes | full server instructions |
| examples and anti-pattern catalogs | only for high-error tools | yes |
| mode-specific workflow details | only while mode active | yes |

### Phase 4: Compress wording only after history review

Use the `tool-prompt-optimization` workflow for tool prompts and an equivalent process for system sections:

1. Measure current tokens.
2. Identify repeated or schema-inferable text.
3. Run `git blame` on candidate lines.
4. Keep lines tied to real failure history.
5. Replace repeated rules with one canonical rule and cross-reference.
6. Verify behavior with targeted prompt/agent-loop tests, not source text greps.

### Phase 5: Add prompt profiles

Not every session needs the full staff-engineer harness.

Useful profiles:

- `full`: current default.
- `review`: no edit workflow, no write/test cleanup policy unless review asks for patch.
- `answer`: direct Q&A; minimal tool policy, no delivery workflow.
- `plan`: planning/interview policy, no implementation cleanup.
- `subagent`: compact worker prompt; parent contract passed through `task.context`.
- `no-tools`: pure reasoning turn with tool inventory omitted.

Each profile must state what it omits and when it is safe.

## Concrete low-risk cuts to investigate

These are candidates, not approved deletions:

1. Merge repeated "never yield / complete task / no partial work" wording from system prompt sections into one canonical contract.
2. Shorten internal URL descriptions to one line each; move selector examples to `read` prompt and docs.
3. Move most examples from global tool policy to the individual tool prompts or provider schema descriptions.
4. Cap skills list to names plus 8-12 word trigger descriptions.
5. Summarize loaded context files with hard-rule extraction, retaining full file behind `read` path.
6. Change MCP instruction injection from raw text to deterministic safety/routing summary plus link.
7. Keep workspace tree off by default; when enabled, inject a budgeted summary and link to `glob`/`read` drilldown.
8. Make mode notices self-destruct after the first relevant turn when they are reminders rather than permanent policy.

## Verification checklist for any future implementation

Before merging token-saving prompt changes:

- Run prompt-size snapshot before/after with active tool sets for:
  - native-tools default;
  - inline/in-band tool dialect;
  - MCP-heavy session;
  - skill-heavy session;
  - subagent session;
  - custom `SYSTEM.md` and `APPEND_SYSTEM.md` paths.
- Run prompt-cache stability check: same inputs must produce byte-identical prompt.
- Exercise at least these behavior probes:
  - uses `read` instead of shell for file reads;
  - uses `lsp` for known symbol references;
  - reads matching skill before acting;
  - obeys repo `AGENTS.md` hard bans;
  - handles MCP tool discovery when external systems are relevant;
  - does not inline workspace tree when disabled.
- Inspect provider payloads: native tool schemas and system prompt should not duplicate full manuals unless `inlineToolDescriptors` or in-band dialect requires it.

## North-star budget

Target default non-message context before user/task content:

| Category | Target |
|---|---:|
| Stable system block | 1,500-2,000 tokens |
| Project/context rules | 1,000-2,500 tokens, path-scoped where possible |
| Skills metadata | <500 tokens by relevance cap |
| Tool schemas/descriptions | provider minimum; no duplicate manuals in native mode |
| MCP instructions | <1,000 tokens total summary unless a server is actively used |

The current repo already has the right architecture for this direction: prompt blocks, native tool list mode, skill URLs, context breakdown categories, prompt rebuild signatures, and tool-discovery mode. Main work is stricter budgeting and lazy-loading policy, not a rewrite.

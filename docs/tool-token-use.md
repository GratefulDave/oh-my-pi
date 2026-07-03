# Tool Token Use and Optimization

This document reviews how coding-agent tool definitions consume context and where token savings can be made without weakening tool reliability.

## Current tool-token model

There are two separate tool costs:

1. **Provider tool schema cost**
   - Sent as native tool/function definitions when the provider supports native tools.
   - Counted by `estimateToolSchemaTokens()` in `packages/coding-agent/src/modes/utils/context-usage.ts`.
   - Includes each tool's name, description, and JSON schema from `toolWireSchema()`.
2. **System-prompt tool guidance cost**
   - Sent inside the system prompt when needed.
   - With native tools and `inlineToolDescriptors: false`, block 0 renders only a compact active-tool inventory.
   - With in-band/non-native tool dialects or explicit inline descriptors, `renderToolInventory()` emits `# Tool:` sections with descriptions and TypeScript-like parameters.

Primary code paths:

- `packages/coding-agent/src/system-prompt.ts`
  - Builds `toolInfo` and `inventoryTools` from active tool metadata.
  - Uses `toolListMode = !inlineToolDescriptors && nativeTools`.
  - Uses `renderToolInventory()` only when tool descriptions must be inline.
- `packages/ai/src/dialect/inventory.ts`
  - `renderToolInventory()` emits `# Tool: <name>`, demoted description headers, parameter type text, and examples.
- `packages/coding-agent/src/session/agent-session.ts`
  - Provider payload includes `description` and `parameters: toolWireSchema(tool)` for active tools.
- `packages/coding-agent/src/modes/utils/context-usage.ts`
  - Estimates tool schema tokens by counting tool names, descriptions, and serialized schemas.
- `scripts/tool-prompt-usage.ts`
  - Estimates rendered built-in tool prompt template costs with representative settings.

## Rendered built-in tool prompt costs

Command used:

```bash
bun scripts/tool-prompt-usage.ts --json
```

Encoding: `o200k_base`.

Total rendered built-in tool prompt templates:

| Prompts | Tokens | Chars | Lines |
|---:|---:|---:|---:|
| 41 | 13,914 | 56,312 | 896 |

Largest rendered tool prompts:

| Tool prompt | Tokens | Chars | Lines |
|---|---:|---:|---:|
| `browser.md` | 1,357 | 4,929 | 45 |
| `eval.md` | 1,336 | 5,089 | 66 |
| `read.md` | 1,078 | 3,662 | 67 |
| `task.md` | 838 | 3,917 | 53 |
| `apply-patch.md` | 707 | 2,896 | 65 |
| `bash.md` | 690 | 2,794 | 46 |
| `patch.md` | 649 | 2,750 | 57 |
| `lsp.md` | 579 | 2,226 | 28 |
| `irc.md` | 543 | 2,367 | 24 |
| `todo.md` | 531 | 1,984 | 39 |
| `github.md` | 489 | 1,620 | 17 |
| `ast-grep.md` | 437 | 1,678 | 25 |
| `ast-edit.md` | 401 | 1,481 | 22 |
| `debug.md` | 363 | 1,390 | 17 |

The estimator renders template conditionals with representative defaults. Live session cost differs by active tool set, provider dialect, task agent list, available runtimes, settings, custom tools, MCP tools, and discoverable-tool mode.

## Why tools are expensive

### 1. Descriptions duplicate schema fields

Native providers receive:

- tool name;
- description;
- JSON schema;
- parameter names;
- parameter descriptions;
- enum values;
- required fields.

If the system prompt also inlines the full manual, a tool's parameter surface can be described twice. Current native `toolListMode` avoids most duplication by listing names only, but provider schemas still carry long descriptions.

### 2. Some prompts are manuals, not routing cards

Large prompts such as `browser`, `eval`, `read`, `task`, and edit/hashline carry detailed syntax and operational rules. Much of that is load-bearing because these tools have DSLs or non-obvious workflows.

But not every line belongs in every session:

- examples can often move behind on-demand help;
- full helper catalogs can move behind targeted docs;
- parameter explanations already present in schemas can be pruned after history review;
- mode-specific branches should render only when active.

### 3. Dynamic tool lists can explode

Built-in tools are bounded. MCP and extension tools are not.

Costs grow with:

- number of active MCP tools;
- verbose MCP tool descriptions;
- large MCP schemas;
- discoverable tool summaries;
- server instructions appended to the system prompt;
- tools that copy external API docs into their description.

### 4. The `task` tool includes agent inventory

`task.md` renders available agents with names, descriptions, and read-only badges. In sessions with many agents, this becomes a dynamic tool prompt expansion.

### 5. In-band tool dialects require inline descriptors

Models without native tool calling need tool manuals in the prompt. For these providers, tool token savings must come from shorter manuals and fewer active tools, not from relying on native schemas.

## Tool prompt authoring rule

A tool prompt should contain only what changes model behavior:

- when to choose the tool;
- when not to choose it;
- input grammar that is not inferable from schema;
- failure modes the model can fix by changing its next call;
- output shape needed for follow-up calls;
- small examples for high-error syntax.

Keep out:

- implementation internals;
- exhaustive API docs already represented in schema;
- prose that restates `required`, enum values, or obvious parameter types;
- long examples for rare paths;
- provider/runtime history;
- troubleshooting the engine handles automatically.

Exception: keep scar-tissue rules. If `git blame` shows a line was added after a real model failure, do not delete it just because it is inferable.

## Optimization strategy by tool class

### Class A: simple parameter tools

Examples:

- `ask`;
- `write`;
- `memory-edit`;
- `recall`;
- `reflect`;
- `retain`;
- `resolve`;
- `web-search`.

These should be schema-first. Prompt can be a short routing card plus one or two caveats.

Target:

- 50-200 tokens each.

Prune candidates:

- field-by-field restatements;
- examples that duplicate schema shape;
- generic warnings already in global policy.

### Class B: routing tools with operational caveats

Examples:

- `bash`;
- `grep`;
- `glob`;
- `read`;
- `lsp`;
- `github`;
- `job`;
- `irc`.

These need more prompt text because wrong tool choice wastes context or causes bugs.

Target:

- 200-700 tokens each, except `read` may remain larger because selector grammar is central.

Keep:

- tool-selection boundaries;
- cross-tool routing rules;
- output shape;
- defaults not visible in schema;
- exact syntax for selectors, refs, or wait behavior.

Prune candidates:

- duplicated examples;
- verbose prose around obvious fields;
- repeated global shell bans if a single canonical global rule plus tool-local pointer works.

### Class C: DSL or grammar tools

Examples:

- `edit` / hashline prompt;
- `ast_grep`;
- `ast_edit`;
- `browser` selectors and ARIA refs;
- `eval` helper prelude.

These prompts are expensive but often load-bearing. The grammar is not inferable from JSON schema.

Target:

- Smaller only through structure, not deletion by vibes.

Better designs:

- split quick-start from full grammar;
- expose `tool.help` or internal URL for rare operators;
- use constrained decoding or schema descriptions to move syntax support out of prose;
- keep examples only for mistakes proven common by telemetry.

### Class D: orchestration tools

Examples:

- `task`;
- `todo`;
- `checkpoint` / `rewind`;
- `goal`.

These prompts teach workflow, not just API shape.

Target:

- Keep core workflow rules inline.
- Move full policy and examples into mode-specific docs.

Specific candidate:

- `task.md` should not list full agent manuals. It should list agent names and one-line descriptions only; full agent prompts belong inside subagent startup.

### Class E: dynamic external tools

Examples:

- MCP tools;
- extension tools;
- custom SDK tools.

These need enforcement at registration time because prompt authors may not follow project style.

Recommended gates:

- token budget per tool description;
- token budget per schema description field;
- warning when a custom/MCP tool exceeds budget;
- automatic summary for discovery index;
- full original description stored out-of-band for on-demand retrieval;
- deterministic summarization to preserve prompt cache.

## Prompt-size budget recommendations

Default native-tool session:

| Component | Target |
|---|---:|
| Active built-in tool descriptions in provider schemas | minimize; exact target depends on active tools |
| System prompt tool inventory | names only, <300 tokens for built-ins |
| Tool manuals inline | 0 tokens in native mode unless explicitly requested |
| MCP active schemas | budgeted per server and tool |
| Discoverable tool summary | <500 tokens |

In-band/non-native session:

| Component | Target |
|---|---:|
| Active tool manuals | active tools only, no discoverable long tail |
| Each simple tool | <200 tokens |
| Each routing tool | <700 tokens |
| DSL tools | allow larger, but split rare syntax |
| Total inline tool inventory | <6,000 tokens for default tool set |

MCP-heavy session:

| Component | Target |
|---|---:|
| Active MCP tools | user/task-selected subset only |
| Tool descriptions | summary card by default |
| Full schemas | native provider payload only when active |
| Server instructions | safety/routing summary plus link |
| Discovery | `search_tool_bm25` instead of full inventory |

## Concrete optimization candidates

### 1. Add CI prompt budget snapshots

Create a deterministic budget test or script output for:

- default native built-in tools;
- inline/in-band built-in tools;
- default with MCP discovery enabled;
- large MCP mock server;
- task tool with bundled agents;
- no-tools profile;
- subagent profile.

Do not assert source text. Assert rendered prompt/category token budgets.

### 2. Enforce custom/MCP tool description budgets

At tool registration or discovery:

- count description tokens;
- count schema tokens;
- warn or summarize over budget;
- preserve original full text out-of-band.

This prevents one verbose MCP server from eating the window.

### 3. Split long tool prompts into routing card + manual

Example pattern:

```text
Tool: browser
Inline card:
- Use for JS-required pages or interactive browser actions.
- Prefer read for static URLs.
- Open before run; observe before click; re-observe after navigation.
- For full selector/API reference, read tool://browser/manual.
```

Full manual remains available through an internal URL or tool help call.

Risk:

- Some models need examples inline to call complex tools correctly. Use telemetry and A/B tests; keep examples for high-error tools.

### 4. Move schema-obvious field docs out of prompts

Candidates:

- parameter type restatements;
- required/optional field lists;
- enum option repetition;
- examples that only show JSON shape.

Keep field docs in schema descriptions where the provider already sees them.

### 5. Keep cross-tool routing centralized

Tool prompts currently repeat shell/search/read/eval routing in several places. Centralize:

- one global tool-routing contract;
- short tool-local caveats only where needed;
- no repeated lists of banned shell substitutes in every tool prompt.

Risk:

- Repetition can be intentional because models forget. Cut only after behavior tests.

### 6. Use active tool packs

Instead of defaulting to every built-in tool:

- base pack: `read`, `grep`, `glob`, `edit`, `write`, `bash`, `eval`, `todo`, `ask`;
- code pack: add `lsp`, `ast_grep`, `ast_edit`, `debug`;
- web pack: add `browser`, `web_search`, `github`;
- orchestration pack: add `task`, `job`, `irc`, `checkpoint`, `rewind`;
- memory pack: add `recall`, `reflect`, `retain`, `memory_edit`;
- media pack: add image tools.

Activate packs from user intent, model capabilities, and settings. Keep `search_tool_bm25` or equivalent available to discover inactive tools.

Risk:

- If a needed tool is inactive and discovery fails, task quality drops. Tool pack activation must be conservative.

### 7. Summarize agent inventory in `task.md`

Current `task.md` dynamically lists available agents. Keep only:

- name;
- one-line description;
- read-only marker;
- maybe max 1 usage trigger.

Move full agent prompt detail to subagent session startup. If many agents exist, make the parent call `search_tool_bm25` or an agent-discovery tool instead of inlining all descriptions.

### 8. Cache tool prompt bytes by signature

Prompt cache effectiveness depends on byte stability.

Cache keys should include:

- active tool names and wire names;
- tool description hashes;
- schema hashes;
- provider dialect;
- settings affecting prompt rendering;
- agent inventory hash for `task`;
- MCP server instruction hashes.

Avoid nondeterministic ordering from maps or discovery results.

## Per-tool review notes

### `browser.md`

Cost: 1,357 rendered tokens.

Reasonable cost drivers:

- open/run/close modes;
- Puppeteer environment;
- selector caveats;
- `observe()` / `ariaSnapshot()` refs;
- navigation invalidation;
- screenshot guidance.

Optimization candidates:

- move exhaustive helper list to manual;
- keep only high-frequency helpers inline;
- collapse selector examples;
- leave `open before run`, `observe first`, and `re-observe after navigation` inline.

### `eval.md`

Cost: 1,336 rendered tokens.

Reasonable cost drivers:

- persistent cell semantics;
- helper prelude;
- Python/JS differences;
- DAG/subagent helpers.

Optimization candidates:

- split helper catalog into compact table plus manual;
- render only enabled languages;
- render subagent DAG section only when `agent()` helper is enabled;
- remove budget helper docs from sessions that do not expose budget controls.

### `read.md`

Cost: 1,078 rendered tokens.

Reasonable cost drivers:

- one path supports files, dirs, archives, SQLite, URLs, internal URLs, images, docs;
- selector grammar is essential for edits and context savings.

Optimization candidates:

- keep selector grammar inline;
- move detailed SQLite/archive examples to manual;
- shorten URL/docs/image cases to routing cues.

### `task.md`

Cost: 838 rendered tokens plus dynamic agent inventory.

Optimization candidates:

- keep delegation strategy and format contract;
- cap agent list or summarize by category;
- move examples and long descriptions out.

### edit/hashline prompts

Costs:

- `packages/hashline/src/prompt.md`: about 1,932 static tokens.
- `apply-patch.md`: 707 rendered tokens.
- `patch.md`: 649 rendered tokens.

Reasonable cost drivers:

- exact patch grammar;
- stale tag rules;
- body-row rules;
- anti-patterns.

Optimization candidates:

- avoid loading multiple edit dialect prompts in the same session if only one edit mode is active;
- keep grammar and critical rules inline;
- move rare anti-patterns to manual only after telemetry shows low value.

## Verification checklist for future tool-token changes

For each prompt edit:

1. Run `bun scripts/tool-prompt-usage.ts --json` before and after.
2. Compare provider payload size using `computeNonMessageBreakdown()` or session context panel.
3. If pruning a tool prompt line, `git blame` it first.
4. Verify actual behavior, not source text:
   - `read`: range selector and edit-anchor flow;
   - `bash`/`eval`: inline script routing goes to `eval`;
   - `grep`/`glob`: exact search/path discovery routing;
   - `lsp`: references before exported-symbol edits;
   - `browser`: open/run/observe/click flow;
   - `task`: batch contract and subagent assignment format;
   - `edit`: hashline patch with fresh tag succeeds.
5. Test both native-tool and inline/in-band dialects.
6. Test MCP-heavy startup with a verbose mock tool/server.
7. Confirm prompt rebuild is byte-stable for unchanged tool sets.

## Summary

Best savings are not from deleting complex tool instructions blindly. Best savings come from:

- relying on provider-native schemas where available;
- keeping system prompt tool inventory compact;
- lazy-loading full manuals for complex tools;
- enforcing budgets on MCP/custom tools;
- activating smaller tool packs;
- summarizing agent and MCP inventories;
- preserving exact scar-tissue rules for high-error tools.

Current architecture already supports much of this: native `toolListMode`, `toolWireSchema()`, context breakdown categories, discoverable tools, and prompt rebuild signatures. Main missing pieces are stricter budgets, deterministic summaries, and on-demand manuals for large tool prompts.

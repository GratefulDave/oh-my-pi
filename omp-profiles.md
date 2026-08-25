# OMP Isolated Profiles — Generated from `modelProfiles` (2026-08-22)

## What

Replaced the `--pm-profile` extension flow with standalone OMP profile homes.
Every `modelProfiles:` block in `~/.omp/agent/config.yml` was materialized as a
full isolated config at:

```
~/.omp/profiles/<name>/agent/config.yml
```

Launch with `omp --profile <name>`. No pm-profile apply step; agent models are
static per home.

## Profiles generated (17)

agents-a1, deepseek, ds4, gratefuldave, grok, mtplx, nvidia, omlx,
openai-hard, openai-massive, openai-mechanical, openai-performance,
openai-review-xhigh, openai-standard, openai-trivial, openrouter,
orinth-1-4bit-mtplx

## Config shape (per profile)

Top-level keys only — no nested `modelProfiles`, no `activeModelProfile`:

```yaml
cycleOrder: [smol, default, plan, slow]
defaultThinkingLevel: auto        # from source block
enabledModels: [...]              # from source block
modelProviderOrder: [...]         # from source block
modelRoles: {...}                 # copied verbatim from source block
task:
  defaultModel: <default-role model>
  agentModelOverrides:
    <agent>: <provider/model:thinking>   # 22 agents
```

## Agent → role mapping

| Agents | Role tier |
|---|---|
| scout, explore, sonic, librarian, init, writer, docs-steward, frontend-qa-scout | smol |
| task, tester, reviewer, actor-coordinator, incident-responder, migration-specialist, nextjs-specialist, tdd-specialist, worktree-manager | task |
| plan, deep-interviewer | plan |
| designer | designer |
| debugger-dap, security-reviewer | slow |

Fallback chain when a role is absent from `modelRoles`: named role →
`default` → first entry. Single-model families (grok, gratefuldave, mtplx,
omlx, orinth) point every agent at their one model.

## nvidia family — distinct model per role

- Coding agents (task/tester/reviewer/etc.): `nvidia/qwen/qwen3-coder-480b-a35b-instruct:auto`
- Smol tier: `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b:auto`
- Slow/review: `nvidia/thinkingmachines/inkling:auto`
- Designer: `nvidia/minimaxai/minimax-m3:auto`
- Default/plan: `nvidia/z-ai/glm-5.2:auto`
- Vision: `nvidia/qwen/qwen3.5-122b-a10b:auto`

## Antigravity

No antigravity/`ag` modelProfile exists in `~/.omp/agent/config.yml`
(`ag/*` appears only as a fallback provider inside the mtplx block). Nothing
was generated for it.

## Backups

The 8 pre-existing profile configs were backed up before overwrite:

```
~/.omp/profiles/<name>/agent/config.yml.bak-20260822-*
# deepseek, ds4, grok, openai-mechanical, openai-performance,
# openai-review-xhigh, openai-standard, openai-trivial
```

## Caveats / R1

- New homes are minimal: theme, `extensions/`, `mcp.json`, `models.db`,
  sessions, and Mnemopi memory are NOT inherited. Copy `extensions/` +
  `mcp.json` from an existing profile (e.g. grok) if needed.
- New agent definitions added later need an explicit
  `task.agentModelOverrides` line in every profile you use, else the agent's
  `.md` frontmatter `model:` wins.

## Scope note

All writes touched `~/.omp/profiles/**` only. Neither this repo (`lex`) nor
`jcode` was modified.

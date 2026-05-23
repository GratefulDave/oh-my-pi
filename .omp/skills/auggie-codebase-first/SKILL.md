---
name: auggie-codebase-first
description: Makes Auggie/Augment codebase retrieval the first discovery step for semantic codebase context. Use when figuring out where behavior is implemented, how code works, what files are involved, or when broad semantic context is needed before reading/searching files. In this repo, Auggie is indexed as GratefulDave/oh-my-pi, not can1357/oh-my-pi.
---

# Auggie Codebase First

## Rule

When trying to understand codebase structure or behavior, make the first repository-discovery request a semantic retrieval call through Auggie/Augment codebase retrieval.

Use it before plain-text search, AST search, file-by-file reading, or exploratory directory walking when the question is about:

- where a concept, feature, behavior, command, or tool is implemented
- how a subsystem works end-to-end
- which files are likely relevant before making a change
- finding code by meaning rather than by an exact symbol or string
- building initial context for debugging an unfamiliar path

## Repository-specific Auggie index

This repo is indexed in Auggie as:

```ts
repo_owner: "GratefulDave"
repo_name: "oh-my-pi"
branch: "main"
```

Do **not** use `git remote get-url origin` for Auggie calls in this checkout. `origin` points to `can1357/oh-my-pi`, which Auggie currently reports as not indexed.

If an Auggie call for this repo returns `[REPO_NOT_FOUND]` and suggests `GratefulDave/oh-my-pi`, retry once with `repo_owner: "GratefulDave"`, `repo_name: "oh-my-pi"`.

## First request

Call the available Auggie/Augment codebase retrieval MCP tool once with the user's intent as the information request.

For this repo, use:

```ts
mcp__auggie_augment_code_search({
	repo_owner: "GratefulDave",
	repo_name: "oh-my-pi",
	branch: "main",
	query: "<user's codebase question or concise restatement>",
	max_results: 10,
});
```

If the exact tool name differs in the active MCP inventory, use the available Auggie/Augment codebase retrieval tool with the same information-request meaning and the same repository identity above.

## Query construction

- Preserve the user's terminology.
- Include observable behavior and any named command, file, package, error, or UI string.
- Do not overfit to guessed filenames or implementation details.
- Keep request broad enough to retrieve neighboring context, not just one symbol.

Good examples:

- `Where is skill discovery implemented and how are ~/.omp/agent/skills loaded?`
- `How does the bash tool render streaming previews and rebuild transcript previews?`
- `Where is MCP tool discovery wired into child task sessions?`
- `How does the agent resolve internal skill:// URLs?`

## After retrieval

Use returned files/sections as starting map, then verify with normal tools:

1. Read relevant returned sections.
2. Use LSP for symbol definitions/references when changing exported code.
3. Use AST or text search only to refine after semantic retrieval.
4. Ignore retrieval results conflicting with current files; repository state wins.

## When not to use

Do not start with retrieval when:

- exact file and line already known
- task purely mechanical inside already-open file
- user asks only for literal text search
- no Auggie/Augment retrieval tool available; then fall back to best available repo search/exploration tool

# Extensions to Remove or Keep

## Remove candidate

### `packages/antigravity-adapter`

Core now has Antigravity provider/OAuth support, so the adapter is likely obsolete.

Core replacements:

- `packages/ai/src/providers/google-gemini-cli.ts` handles Google Gemini CLI / Antigravity provider behavior.
- `packages/ai/src/provider-models/google.ts` exposes `googleAntigravityModelManagerOptions`.
- `packages/ai/src/auth-storage.ts` wires Antigravity usage/provider support.
- `packages/ai/src/models.json` includes `google-antigravity` model entries.

Old extension behavior:

- `packages/antigravity-adapter/src/extension.ts` registers an OpenCode Antigravity bridge through `opencode-antigravity-auth`.

Removal caveat:

- Before deletion, confirm no external install path still depends on the old bridge provider ID or `/login opencode-antigravity` flow.

## Do not remove yet

### `.omp/extensions/semantic-search`

Core overlaps with much of the day-to-day retrieval workflow:

- `search` covers native regex/grep search.
- `find` covers native glob/file discovery.
- `ast_grep` covers structural AST search.
- `lsp` covers definitions, references, symbols, diagnostics, and code actions.
- `mnemosyne` covers semantic memory recall.

Missing core equivalent:

- cwd-local `.omp/semantic-search/index.db` source-code index.
- source chunks with path, symbol, start/end line, and content fields.
- FTS5 plus embedding rerank over repository source chunks.
- `/semantic-index`, `/semantic-search`, `/semantic-status` commands.
- `local_semantic_search` tool.

Recommendation:

- Keep unless we explicitly accept losing local semantic source-code indexing, or replace it with a core implementation.
- If removed, also delete or rewrite `packages/coding-agent/test/local-semantic-search-extension.test.ts`, which directly imports the extension.

## Keep

### `packages/swarm-extension`

No core equivalent found. It owns `/swarm` YAML pipeline orchestration:

- DAG wave execution.
- Reservations.
- Durable state/feed inspection.
- Subprocess agent pipeline control.

Recommendation:

- Keep unless a separate core swarm orchestration implementation replaces those contracts.

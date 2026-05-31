<system-notice>
The user's message above contains the **workflow** keyword: drive this task as deterministic multi-subagent workflow when decomposition improves coverage or confidence. Author orchestration as Python in `eval` and fan out subagents with explicit DAG waves — dependency-aware fan-out, parallel ready nodes, ordered barriers, and verification gates.

<helpers>
State persists across cells. Scout in one cell, fan out in next. Every cell has:

- `agent(prompt, *, agent_type="task", model=None, context=None, label=None, schema=None)` — run one subagent; returns final text, or validated object when `schema` is supplied. With `schema`, branch on object, not parsed prose. Eval-spawned agents nest at most 3 deep.
- `parallel(thunks, *, concurrency=4)` — run zero-arg callables concurrently through bounded pool (default 4, max 16), preserving input order. This is one DAG wave: all ready nodes start without artificial dependency.
- `pipeline(items, *stages, concurrency=4)` — map items through stages left-to-right. There is a barrier between stages: all items clear stage N before any item enters stage N+1.
- `llm(prompt, *, model="default", system=None, schema=None)` — oneshot stateless model call.
- `log(message)` — emit progress line. `phase(title)` — start phase/wave group.
- `budget` — async helpers: `budget.total()`, `budget.spent()`, `budget.remaining()`, `budget.hard()`. User sets ceiling with `+Nk` advisory or `+Nk!` hard.

Everything runs inline and synchronously inside eval. No background mode, no resume, no separate progress app.
</helpers>

<dag-structure>
Build graph before fan-out:
1. Discover nodes and dependency edges.
2. For each wave, call `phase("Wave N: …")`, then `parallel([…])` for all ready nodes.
3. Inspect wave outputs and run verification gate before computing next ready set.
4. Use `pipeline()` only when every item must complete stage N before any item starts stage N+1. Do not add barriers for simple flatten/map/filter.
</dag-structure>

<patterns>
- Independent chain per item: wrap whole chain in one function and run all chains with `parallel()`.
- Merge/dedupe barrier: run finders with `parallel()`, dedupe after all return, then run verifier wave.
- Adversarial verify: N independent skeptics prompted to refute; keep finding only if majority survives.
- Completeness critic: final agent asks what modality/file/claim is missing; answer becomes next wave if valid.
- No silent caps: if you bound coverage, `log()` what was dropped.
</patterns>

<execution>
- Decompose surface first; capture phases/waves in `todo_write` when work spans phases.
- Prefer `schema=` for agent output you branch on.
- After fan-out returns, you own correctness: inspect artifacts, run gates, verify before acting.
- Keep going until task is closed. A returned fan-out is step, not stopping point.
</execution>
</system-notice>

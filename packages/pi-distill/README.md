# pi-distill

Pi / oh-my-pi (OMP) extension that **structurally compresses large JSON/YAML output
from MCP tools** before it enters the model context window — and spills the full
original to a recoverable session artifact so nothing is lost.

## Why

OMP already minimizes shell output (native `pi-shell` minimizer) and spills large
**builtin** tool results to artifacts (`read`, `fetch`, `grep`, …). But **MCP / custom
tools bypass that path entirely** — their output is wrapped by `ExtensionToolWrapper`,
never by `wrapToolWithMetaNotice`, so a fat JSON payload from an MCP server lands in
context raw and full. pi-distill is the missing piece for that surface.

It does **not** touch builtin/shell output (those are already covered) and skips any
result that already carries a native artifact reference.

## How it works

On every `tool_result`, for MCP/custom tools only:

1. Sniff each text part — is it JSON (strict parse) or YAML (optional `yaml` dep)?
2. Structurally compress: long arrays collapse to head + `…(+N items elided)` + tail;
   long strings truncate with a char tally; object keys and nesting are preserved so
   the in-context view stays **valid, queryable** JSON/YAML (not byte-chopped).
3. **Spill the full original to a session artifact first**, then replace the part with
   the compact body plus a footer:

   ```
   [pi-distill: json compressed, 38 nodes elided.
    Full output: artifact://<id> — read it to recover dropped detail.]
   ```

The model reads `artifact://<id>` whenever it needs an elided element. **Lossy in
context, lossless on disk.** If the artifact spill fails (e.g. non-persisted session),
the part passes through uncompressed — pi-distill never elides what it cannot recover.

## Install

```bash
pi install npm:pi-distill
```

Or for local development, drop the repo path into your OMP `extensions` setting, or
symlink `src/index.ts` into `~/.omp/agent/extensions/`.

## Commands

| Command | Effect |
| --- | --- |
| `/distill` | Toggle compression on/off |
| `/distill-stats` | One-line toast: KB saved + result count this session |
| `/distill-gain` | Full savings view (like `rtk gain`): this-project + global totals (KB, est. tokens, % reduction) with scrollable per-session history. Rich TUI overlay; plain-text fallback when no UI |

## Savings tracking

Every compression is recorded to two JSON stores (read-merge-write, fail-safe):

- per-project: `<project>/.omp/pi-distill-stats.json`
- global rollup: `~/.omp/agent/extensions/pi-distill/stats.json`

`/distill-gain` aggregates both — project total, all-time global total, and a
recent-first session history. Stats flush on each hit (debounced) and on
session/agent end.

## Configuration

Defaults work out of the box. Override via `PI_DISTILL_*` env vars or
`~/.omp/agent/extensions/pi-distill/config.json` (env wins over file wins over default):

```json
{
  "minBytes": 4096,
  "arrayHead": 8,
  "arrayTail": 4,
  "scalarMax": 240,
  "verbatimTools": ["a_tool_whose_output_must_stay_verbatim"]
}
```

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `minBytes` | `PI_DISTILL_MIN_BYTES` | 4096 | Skip text parts smaller than this |
| `arrayHead` | `PI_DISTILL_ARRAY_HEAD` | 8 | Array elements kept from the front |
| `arrayTail` | `PI_DISTILL_ARRAY_TAIL` | 4 | Array elements kept from the back |
| `scalarMax` | `PI_DISTILL_SCALAR_MAX` | 240 | Max string length before truncation |
| `verbatimTools` | `PI_DISTILL_VERBATIM_TOOLS` (comma-sep) | — | Tools never compressed |

## Scope / non-goals

- **MCP/custom tools only.** Builtin and shell output is covered by OMP's native
  minimizer and artifact spill, and by extensions like `pi-lean-ctx` / `context-mode`.
- Lossy preview by design; recovery is via the spilled artifact, not in-context.

## License

MIT

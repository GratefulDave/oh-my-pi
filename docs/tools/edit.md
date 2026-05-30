# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/hashline/src/prompt.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/hashline/src/grammar.lark` — canonical constrained-decoding grammar
  - `packages/hashline/src/format.ts` — sigils and header constants (`¶`, `#`, `+`, `replace`, `delete`, `insert`)
  - `packages/hashline/src/input.ts` — parses `¶PATH#TAG` sections
  - `packages/hashline/src/tokenizer.ts` / `packages/hashline/src/parser.ts` — tokenizes and parses ops
  - `packages/hashline/src/apply.ts` — applies parsed edits to file text
  - `packages/hashline/src/mismatch.ts` — stale-anchor mismatch formatting
  - `packages/hashline/src/recovery.ts` — snapshot-based stale-anchor recovery
  - `packages/hashline/src/snapshots.ts` — mints and resolves per-path opaque snapshot tags

## Inputs

### Hashline mode (default)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more file sections. Anchored sections start with `¶PATH#TAG`; hashless `¶PATH` is allowed only for new-file creation or purely `insert head:` / `insert tail:` inserts. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- **File header**: `¶PATH#TAG` (or `¶PATH` for new-file / head/tail-only inserts). `TAG` is three uppercase-hex chars minted by the session snapshot store.
- **Operations**:
  - `replace N..M:` — replace original lines N..M with the body rows below.
  - `delete N..M` — delete original lines N..M. No body.
  - `insert before N:` — insert body rows immediately before line N.
  - `insert after N:` — insert body rows immediately after line N.
  - `insert head:` — insert body rows at the start of the file.
  - `insert tail:` — insert body rows at the end of the file.
- **Body rows**:
  - Only body-bearing headers end in `:`.
  - Every body row is `+TEXT`; `+` alone adds a blank line.
  - `delete` never has body rows.
  - There is no repeat row kind. To keep a line, leave it out of every range; split edits into multiple hunks when needed.
  - `-` rows are invalid. Literal text beginning with `-` or `+` must be written as `+-text` / `++text`.

Anchors come from `read`/`search` output. `read` emits a `¶PATH#TAG` header from the session snapshot store and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into hunk headers.

### Tolerated input shapes (lenient parsing)

The canonical grammar is strict, but the hand parser accepts a few non-dangerous variants:

- `replace N:` — accepted as `replace N..N:`.
- `delete N` — accepted as single-line delete.
- Missing trailing colon on `replace` or `insert` — accepted.
- `replace N-M:`, `replace N…M:`, and `replace N M:` — accepted as `replace N..M:`.
- Bare body rows with no `+` prefix are auto-prepended with `+` and a `BARE_BODY_AUTO_PIPED_WARNING` is appended.
- `*** Begin Patch` / `*** End Patch` envelopes are silently consumed. `*** Abort` terminates parsing silently — ops parsed before the marker still apply, no warning surfaced.
- `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` apply_patch sentinels throw an `apply_patch sentinel … is not valid in hashline` error.
- `@@`-bracketed hunk headers are rejected with guidance to write a verb header.
- Bare `N` and bare `N M` / `N..M` headers are rejected with guidance to write `replace` or `delete`.
- `delete N..M:` and any body rows under `delete` are rejected.
- Empty `replace` / `insert` hunks are rejected.
- `-` body rows are rejected with `MINUS_ROW_REJECTED`.

## Outputs
- Single-shot tool result; hashline mode does not use a `resolve` preview/apply handshake.
- `content` contains one text block per call. For a successful single-file edit it is either:
  - `<path>:` plus a compact diff preview from `packages/hashline/src/diff-preview.ts`, or
  - `Updated <path>` / `Created <path>` when no compact preview text is emitted.
- Parse or recovery warnings are appended as:

```text
Warnings:
...
```

- `details` is `EditToolDetails` from `packages/coding-agent/src/edit/renderer.ts`:
  - `diff`: unified diff string
  - `firstChangedLine`: first changed post-edit line
  - `diagnostics`: LSP/format result if available
  - `op`: `"create"` or `"update"` for hashline mode
  - `meta`: output metadata
  - `perFileResults`: present for multi-section input
- Multi-section input returns one aggregated result with combined text and per-file details.
- While the model is still typing arguments, the TUI can compute a diff preview with `packages/coding-agent/src/edit/streaming.ts`; that preview is not a deferred action and does not block execution.

## Flow
1. `EditTool.execute()` in `packages/coding-agent/src/edit/index.ts` resolves the active mode. Default is `hashline`; `customFormat` exposes `packages/hashline/src/grammar.lark` as a constant string with op sigils and the section-header `¶` inlined.
2. `executeHashlineSingle()` in `packages/coding-agent/src/edit/hashline/execute.ts` splits the raw `input` into `¶PATH#HASH` / `¶PATH` sections with `splitHashlineInputs()`.
3. If multiple sections target the same path, `mergeSamePathSections()` concatenates them before execution so every op still refers to the original file snapshot.
4. Multi-section calls run a preflight pass (`preflightHashlineSection()`): parse ops, enforce plan-mode write rules, load the current file, reject anchor-scoped edits against missing files, reject auto-generated files, apply edits in memory, and fail if the result is a no-op. This prevents partial batches.
5. `parseHashlineWithWarnings()` in `packages/hashline/src/parser.ts` tokenizes the diff body:
   - ignores blank lines and optional `*** Begin Patch`
   - stops at `*** End Patch`
   - stops at `*** Abort` and emits `ABORT_WARNING`
   - turns `↓` / `↑` payload runs (inline plus subsequent lines) into one `insert` edit per payload line
   - turns `A-B:` with payload into inserts before `A`, then deletes for `A-B`
   - turns `A-B!` into one `delete` edit per line in the range; payload is forbidden
6. `executeHashlineSingle()` computes the current file hash before applying anchored edits. If it differs from the section `#HASH`, recovery tries the read/search snapshot cache before any write.
7. `applyHashlineEdits()` validates only line bounds, then applies the already hash-bound line-number edits.
8. Recovery replays the edits against the cached snapshot for the section hash (`packages/coding-agent/src/edit/file-snapshot-store.ts`), then 3-way merges the result onto current disk content using `Diff.applyPatch(..., { fuzzFactor: 0 })` in `packages/hashline/src/recovery.ts`. On success the edit proceeds with a warning; on failure a `HashlineMismatchError` is surfaced.
9. Before splicing lines, `absorbReplacementBoundaryDuplicates()` normalizes some malformed-but-recoverable ranges:
   - duplicate prefix/suffix lines adjacent to a replacement can be absorbed by widening the delete range
   - pure inserts can auto-drop duplicated leading/trailing payload lines when `edit.hashlineAutoDropPureInsertDuplicates` is enabled
   - all such fixes append warnings
10. `after_anchor` inserts are normalized to `before_anchor` of the next line, or `EOF` if the anchor was the last line.
11. Anchor-targeted edits are bucketed by target line and applied bottom-up so earlier splices do not invalidate later original line numbers. `BOF` and `EOF` inserts are applied after that.
12. The edited text is restored to the original BOM and line ending style with helpers from `packages/coding-agent/src/edit/normalize.ts` and persisted via `serializeEditFileText()` in `packages/coding-agent/src/edit/read-file.ts`.
13. The writethrough callback from `createLspWritethrough()` may format the file and fetch diagnostics. Late diagnostics are queued back into session state as a hidden deferred message by `EditTool.#injectLateDiagnostics()` in `packages/coding-agent/src/edit/index.ts`.
14. `invalidateFsScanAfterWrite()` calls `invalidateFsScanCache(path)` so filesystem-backed tools do not serve stale scan results.
15. The session file-read cache is refreshed with the post-edit file text via `recordContiguous()`, making the just-written content the new recovery base for subsequent stale-anchor merges.
16. The final response is built from a unified diff (`generateDiffString()`), a compact preview, and any accumulated warnings.

## Modes / Variants
- `hashline` — default mode; line-anchored patch language described here (`packages/coding-agent/src/utils/edit-mode.ts`).
- `replace` — exact/fuzzy old/new text replacement (`packages/coding-agent/src/edit/modes/replace.ts`).
- `patch` — structured JSON diff-hunk mode (`packages/coding-agent/src/edit/modes/patch.ts`).
- `apply_patch` — freeform Codex-style `*** Begin Patch` envelope, internally expanded into patch-mode entries (`packages/coding-agent/src/edit/modes/apply-patch.ts`).

Hashline op examples (single-line payloads are inline; multi-line payloads continue on subsequent lines):

```text
¶src/a.ts#1a2b
4↓const added = true;
```

```text
¶src/a.ts#1a2b
4↑const addedBefore = true;
```

```text
¶src/a.ts#1a2b
4-6:const replacement = true;
```

```text
¶src/a.ts#1a2b
4-5:const clean = (name || DEF).trim();
return clean.length === 0 ? DEF : clean.toUpperCase();
```

```text
¶a.ts#0A3
replace 1..1:
+const X = "b";
+export const Y = X;
```

Insert below line 5:

```text
¶a.ts#0A3
insert after 5:
+console.log(X + Y);
```

Insert above line 5:
```text
¶a.ts#0A3
insert before 5:
+console.log(X + Y);
```

Delete / blank examples:

```text
¶a.ts#0A3
delete 4..5
```

```text
¶src/a.ts#1a2b
4:
```

```text
¶a.ts#0A3
insert head:
+// header
insert tail:
+// trailer
```

Multi-file example:

```text
¶src/a.ts#0A3
replace 4..4:
+const enabled = true;
¶src/b.ts#1F7
delete 20
```

## Side Effects
- Filesystem
  - Reads target files with `readEditFileText()`.
  - Writes full updated file contents with `serializeEditFileText()`.
  - Preserves BOM and original line-ending style.
- Subprocesses / native bindings
  - `createLspWritethrough()` may trigger formatter / diagnostics work through the LSP subsystem.
  - `invalidateFsScanAfterWrite()` calls native `invalidateFsScanCache()` from `@oh-my-pi/pi-natives`.
- Session state
  - Reads and updates the per-session `FileReadCache` used for stale-anchor recovery.
  - Stores pending deferred-diagnostics abort controllers per path inside `EditTool`.
  - Queues late diagnostics back into the session transcript as a hidden custom message.
- Background work / cancellation
  - A new edit to the same path aborts the prior deferred diagnostics fetch for that path (`packages/coding-agent/src/edit/index.ts`).
  - The tool itself is marked `nonAbortable = true` and `concurrency = "exclusive"` in `packages/coding-agent/src/edit/index.ts`.

## Limits & Caps
- File snapshot tags are exactly three uppercase-hex chars minted by the per-session snapshot store.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/hashline/src/messages.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` in `packages/hashline/src/recovery.ts`.
- `HL_FILE_PREFIX` is `¶`, `HL_PAYLOAD_REPLACE` is `+`, `HL_RANGE_SEP` is `..`, `HL_FILE_HASH_SEP` is `#`, and hunk keyword constants are `replace` / `delete` / `insert` (`packages/hashline/src/format.ts`).

## Errors
- Missing section header:
  - `input must begin with "¶PATH#HASH" on the first non-blank line for anchored edits; got: ...`
- Empty header:
  - `Input header "¶" is empty; provide a file path.`
- Missing hash for anchored edit:
  - `Missing hashline file hash for anchored edit to <path>; use ¶<path>#hash from your latest read.`
- Line-hash anchors in edit ops:
  - `line N: edit ops use bare line numbers. Copy the ¶PATH#hash header, then use anchors like 42, 42-45, BOF, or EOF.`
- Bad anchor token:
  - `line N: expected a line number such as "119"; got "...".`
- Bad range syntax:
  - `line N: range must be LINE or LINE-LINE (one dash, no spaces); got ...`
  - `line N: range A-B ends before it starts.`
- Payload forbidden for `!`:
  - `line N: ! deletes only. Payload is forbidden after !; use : to replace.`
- Stray payload line:
  - `line N: payload line has no preceding hunk header. Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` above the body. Got "...".`
- Minus row:
  - ``line N: `-` rows are not valid; hashline ranges already name the lines being changed. To insert a literal line starting with `-`, write `+-…`.``
- Empty body-bearing hunk:
  - `line N: \`replace N..M:\` needs at least one \`+TEXT\` body row. To delete lines, use \`delete N..M\`.`
  - `line N: \`insert\` needs at least one \`+TEXT\` body row.`
- Delete with body:
  - `line N: \`delete N..M\` does not take body rows. Remove the body, or use \`replace N..M:\`.`
- Range out of order:
  - `line N: range A..B ends before it starts.`
- Overlapping hunks on the same anchor:
  - `line N: anchor line X is already targeted by another hunk on line Y. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`
- apply_patch / unified-diff contamination:
  - `line N: apply_patch sentinel "*** …" is not valid in hashline. File sections start with \`¶path#HASH\` (no \`Update File:\` / \`Add File:\` keyword). Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` ops.`
  - `line N: unified-diff hunk header (\`@@ -N,M +N,M @@\`) is not valid in hashline. Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` ops.`
  - `line N: \`@@\`-bracketed hunk header "@@ …" is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a verb header such as \`replace N..M:\`.`
  - `line N: hunk headers need a verb. Use \`replace N..N:\` to replace, or \`delete N\` to delete.`
  - `line N: bare range hunk header "N M" is not valid. Hunk headers need a verb: write \`replace N..M:\` or \`delete N..M\`.`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale snapshot tag: the `Patcher` first attempts snapshot-based recovery. When recovery cannot prove a valid result it throws `MismatchError`, which distinguishes recognized-but-drifted hashes from never-recorded hashes. The error includes the current file hash plus context around each anchor.
- No-op edit:
  - `Edits to <path> resulted in no changes being made.`
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Warnings
- `Auto-prefixed bare body row(s) with +. Body rows must be +TEXT literal lines …` (`BARE_BODY_AUTO_PIPED_WARNING`)
- Recovery banners: `RECOVERY_EXTERNAL_WARNING`, `RECOVERY_SESSION_CHAIN_WARNING`, `RECOVERY_SESSION_REPLAY_WARNING` (`packages/hashline/src/messages.ts`).

# Plan: `/gain` Slash Command — Review & Remediation (rev 3)

**Status:** PENDING APPROVAL
**Mode:** RALPLAN-DR (deliberate)
**Iteration:** 2 of max 5 (post-critic ACCEPT-WITH-RESERVATIONS = ITERATE)
**Scope target:** `packages/coding-agent` in `/Users/davidandrews/PycharmProjects/lex`
**Created:** 2026-05-28
**Revised:** 2026-05-28 (rev 2 post-architect; rev 3 post-critic)
**Author:** planner (oh-my-claudecode)

> **Revision note (rev 3):** Critic verdict ACCEPT-WITH-RESERVATIONS = ITERATE applied. Corrections from rev 2:
> - **M1:** Test-case counts removed from success criteria (rev 2 claimed 13/5; actuals are 11/3). All assertions reworded as "all existing cases remain unmodified and green" with no fixed count.
> - **M2:** `omp gain --json` collision resolved with explicit flag matrix; `--diag` is its own oclif `Flags.boolean` in `commands/gain.ts`; mutual-exclusion contract defined.
> - **M3:** Shape α locked NOW. Rev 2's "decide at T2 start" deferred an architectural call into implementation. Shape β rejected: `brokenShellSessions` precedent does not differentiate the shapes (both are singletons); α has smaller blast radius.
> - **G1–G8:** backwards-compat predicates, T0 artifact capture, T0 bisect time-box, T4 builder-throw fallback, sync-renderStatus + DualContext extension, file-wide vs in-scope counts, platform-portable chmod test, rollback strategy.
> - **MN1–MN3:** `lastParseError` symmetry, `avgSavedRatio` quality metric, refresh-counter source-of-truth clarification.

---

## 1. Context

The `/gain` slash command surfaces token-compression analytics from the native Rust shell-output minimizer (`applyShellMinimizer` in `@oh-my-pi/pi-natives`). Internal to this fork; distinct from the external `rtk gain` CLI.

Every shell command flows through `bash-executor.ts` and produces a JSONL record at `~/.omp/agent/minimizer-gain.jsonl`. The overlay re-reads the entire file every 1s.

User report: "was working, not 100% sure now." Recent churn in this exact area (`d7c300056`, `842f0ff39`, `4addc55cb`, `338908863`) means the symptom may be a regression, not an observability gap. Plan starts with T0 reproduction.

### Key files in scope

- `packages/coding-agent/src/slash-commands/builtin-registry.ts:243-268,295,301-313,321,538` — flag parser, `showGainOverlay()` with `loadContext` closure, report builder, `/gain` spec
- `packages/coding-agent/src/modes/components/minimizer-gain-overlay.ts:7,11,17-22,68,79-90,105-118,234` — `LoadMinimizerGainContext` type, `TABS` const, `DualContext` interface, refresh/render flow
- `packages/coding-agent/src/minimizer-gain.ts:214,232,257-265` — `isSavingsRecord` callsites and definition
- `packages/coding-agent/src/commands/gain.ts:4-29` — oclif command with existing `Flags.boolean` for `--json`, `--all`, `--discover`, `--missed`, `--days`, `--cwd`
- `packages/coding-agent/src/cli/gain-cli.ts:99-113` — `printJsonPayload` shape `{records, summary, discovery, missed}`
- `packages/coding-agent/src/exec/bash-executor.ts:7-14,60,153,299,346,349,373,417,429,451` — native imports, `brokenShellSessions` precedent, 8 `recordMinimizerGain` call sites
- `packages/coding-agent/test/minimizer-gain.test.ts` — existing unit cases (file-wide; no fixed count cited in success criteria)
- `packages/coding-agent/test/bash-executor.test.ts:168-260` — saved + missed integration cases
- `packages/coding-agent/test/modes/components/minimizer-gain-overlay.test.ts` — existing overlay cases (file-wide; no fixed count cited in success criteria)

---

## 2. Principles (5)

1. **Observability before optimization** — make the pipeline self-diagnostic first.
2. **Fail loud at boundaries** — write and read failures must surface; no silent `catch {}`.
3. **Small, additive changes** — extend existing types, tests, and overlay rather than redesign.
4. **Reproduce before remediate** — verify the symptom in the current build before adding instrumentation on top.
5. **Data before architecture** — do not adopt SQLite, ring buffers, or rewrites until the diagnostic itself produces evidence the JSONL path is the bottleneck.

---

## 3. Decision Drivers (top 3)

1. **User trust — "is it working right now?"** A one-command answer (`omp gain --diag --json`) and an always-visible Status tab in the overlay.
2. **Runtime cost under long sessions** — latent, currently unmeasured; the diagnostic exposes the metrics (`loadDurationMs`, `fileSizeBytes`) that decide whether Option B is later justified.
3. **Extend, do not duplicate, existing test coverage** — `test/minimizer-gain.test.ts` and `test/bash-executor.test.ts:168-260` already cover happy paths. New work targets the gaps: diagnostic builder, I/O failure paths, overlay error handling. No fixed test-count assertions (M1).

---

## 4. Viable Options

### Option A — Diagnostic-first (RECOMMENDED, default)

Reproduce symptom, surface I/O failures (Shape α — locked, M3), add `buildMinimizerGainDiagnostic()` with overlay Status tab + CLI `--diag [--json]`, extend existing tests.

**Pros:**
- Smallest change that resolves the reported symptom.
- Backwards compatible: no on-disk format change, no new deps, no behavior change to write sites.
- Surfaces the metrics needed to make a data-driven Option B decision later.

**Cons:**
- The 1s full-file re-parse remains.

### Option B — Diagnostic + perf (CONDITIONAL)

Option A plus tail-streaming read (offset tracking, append-only parse) and size-based rotation (rename to `.1`, `.2`, cap K archives).

**Pros:** eliminates O(N) per-tick re-parse; bounds disk usage.
**Cons:** larger surface; off-by-one risk around rotation; rolling aggregate must remain cwd-correct.
**Trigger criteria (observable via diagnostic):** sustained `fileSizeBytes` > 10 MB in field usage, OR `loadDurationMs` p95 > 50 ms, OR user-reported overlay lag.

### Option C — Full rewrite (INVALIDATED, out of scope)

SQLite or in-memory ring buffer; full overlay redesign.

**Invalidation rationale:**
- No measurement supports the cost (Principle 5).
- Schema migration penalizes existing user data at `~/.omp/agent/minimizer-gain.jsonl`.
- Reported symptom is observability, not throughput.
- Violates Principles 3 and 5.

### Recommendation

**Ship Option A.** Diagnostic metrics live in the overlay Status tab + CLI JSON output so the Option B decision is later driven by real data.

---

## 5. Pre-mortem (3 failure scenarios)

1. **Diagnostic claims "all good" but feature is still broken in the field.**
   *Cause:* Quality regression — minimizer still runs but only shrinks 5% where it used to shrink 60%. On/off check passes; user experience degrades.
   *Mitigation:* Diagnostic includes `avgSavedRatio` (MN2) — surfaces quality, not just liveness. Plus T0 reproduces the symptom against a known-compressible input before any code changes.

2. **Status tab shows zero saved bytes but file has records under a different cwd.**
   *Cause:* worktree / symlink / path-normalization mismatch between the cwd written by `bash-executor` and the cwd matched by `matchesCwd`.
   *Mitigation:* Diagnostic exposes `cwdFilter`, `distinctCwdsCount`, and `distinctCwdsSample`; when current-scope is empty but `distinctCwdsCount > 0`, the Status tab calls that out.

3. **Status tab clips on narrow terminals.**
   *Cause:* TUI overlay is width-sensitive.
   *Mitigation:* Status tab `renderStatus(context, width)` measures width; long fields wrap. CLI `omp gain --diag` is the canonical non-width-bound surface.

---

## 6. Task Flow

```
T0 Reproduce (gate; on regression, bisect 338908863..HEAD ≤2h or defer)
              │
              ▼
T1 Test extension ──┐
                    ├─> T3 Diagnostic API ─> T4 Status tab + DualContext ext ─┐
T2 Error surfacing  ┘                                                          ├─> T6 Extend integration tests ─> T7 Verify
(Shape α locked) ───────────────────────────────────────────────── T5 CLI flag┘
```

T0 blocks T1–T7.

---

## 7. Detailed TODOs

### T0 — Reproduce symptom on current `feat/library-provider` (GATE)

**Pre-condition guard (G2):**
- If `du -h ~/.omp/agent/minimizer-gain.jsonl` exceeds 50 MB at T0 start, archive it: `mv ~/.omp/agent/minimizer-gain.jsonl ~/.omp/agent/minimizer-gain.jsonl.archive-$(date +%s)`. Then proceed from empty. Otherwise file size confounds the symptom.

**Work:**
- `bun run build` in `packages/coding-agent`.
- Launch TUI in this fork.
- Capture `wc -l ~/.omp/agent/minimizer-gain.jsonl` (pre).
- Run a known-compressible command in the TUI: `for i in $(seq 1 200); do echo "hello world $i"; done`.
- Run `/gain`.
- Capture rendered overlay text (copy-paste).
- Capture `wc -l ~/.omp/agent/minimizer-gain.jsonl` (post).
- Capture `tail -1 ~/.omp/agent/minimizer-gain.jsonl` (post).
- Classify: zeros / non-zero / crash / stale.

**Branch decision:**
- **Non-zero saved bytes observed** → symptom is observability gap → proceed with T1–T7 as written.
- **Zero / crash / stale** → symptom is regression. Pause T1–T7. Bisect `338908863..HEAD` over (`d7c300056`, `842f0ff39`, `4addc55cb`, `338908863`).

**Bisect time-box (G3):**
- If bisect exceeds 2 hours OR root cause unclear after the 4 commit candidates, file a separate fix-plan, resume T1–T7 against current HEAD, and record the deferred regression in §13 Open Questions.

**Acceptance (G2):**
- A new `## T0 Observation` section appended to this plan containing all six captures above plus the classification + branch decision.

### T1 — Extend `test/minimizer-gain.test.ts`

**Work (additive only; do NOT rewrite existing cases):**
- Cases for `buildMinimizerGainDiagnostic(input)` (from T3):
  - Empty file → `recordCount: 0`, `mostRecentTimestamp: null`, `recentMissedRatio: null`, `avgSavedRatio: null`.
  - Seeded saved + missed mix → correct counts, `recentMissedRatio`, `avgSavedRatio` in `[0,1]`.
  - 50-record window of pure missed → `recentMissedRatio === 1` and `minimizerAppearsInactive: true`.
  - `distinctCwdsCount` reflects unique cwd values; `distinctCwdsSample` capped at 10.
  - Legacy records with `kind=undefined` and `savedBytes>0` count toward `savedCount` (backwards-compat per G1).
- Cases for I/O failure surfacing (Shape α, T2): assert `getMinimizerGainStatus()` reflects `writeErrorCount`, `readErrorCount`, `parseErrorCount`, and the corresponding `lastWriteError` / `lastReadError` / `lastParseError` (MN1) under simulated failures.

**Acceptance:**
- `bun test` passes locally in `packages/coding-agent`.
- All existing cases in the file remain unmodified and green (no fixed count asserted — M1).

### T2 — Error surfacing (Shape α LOCKED, M3)

**File:** `packages/coding-agent/src/minimizer-gain.ts`

**Shape α — module-level counters:**

```ts
let writeErrorCount = 0;
let readErrorCount = 0;
let parseErrorCount = 0;
let lastWriteError: { error: string; at: string } | null = null;
let lastReadError: { error: string; at: string } | null = null;
let lastParseError: { error: string; lineNumber: number; at: string } | null = null;

export function getMinimizerGainStatus() {
  return { writeErrorCount, readErrorCount, parseErrorCount, lastWriteError, lastReadError, lastParseError };
}

// Test-only reset (gated by NODE_ENV or exported under __testing namespace):
export function resetMinimizerGainStatusForTesting() { /* zero all counters */ }
```

**Rejection of Shape β (recorded for ADR Alternatives):**
- `brokenShellSessions` at `bash-executor.ts:60` is itself a module-level singleton. Shape β's "no global singleton" claim does not survive its own precedent.
- Shape α blast radius: 1 file (`minimizer-gain.ts`). Shape β blast radius: 2 files + 8 call sites.
- T3 reads counters via a single function call instead of plumbing return values through unrelated control flow.

**Work:**
- `recordMinimizerGain` catch: keep existing `logger.warn`; additionally increment `writeErrorCount` and set `lastWriteError`. 8 call sites in `bash-executor.ts` remain `void`-call — no API churn.
- `loadMinimizerGainContext` catch: increment `readErrorCount`, set `lastReadError`.
- Per-line parse errors inside `parseMinimizerGainRecord` callers: increment `parseErrorCount`, set `lastParseError` (MN1).
- Overlay `refresh()` at `minimizer-gain-overlay.ts:113-114`: replace `catch {}` with a call that increments the same `readErrorCount` in `minimizer-gain.ts` (MN3 — one source of truth across overlay + CLI).

**Acceptance:**
- T1 cases pass.
- No new `logger.warn`-only swallow sites introduced.

### T3 — `buildMinimizerGainDiagnostic(input)` in `minimizer-gain.ts`

**Input:** `{ cwd: string; days: number; recordsFilePath?: string }`

**Output (JSON-serializable):**

- `recordsFilePath: string`
- `exists: boolean`
- `fileSizeBytes: number`
- `mtime: string | null` (ISO)
- `recordCount: number` — **file-wide; no cwd or day filter** (G6)
- `recordCountInScope: number` — **filtered by current cwd + days** (G6)
- `savedCount: number` — uses `isSavingsRecord(record)` from `minimizer-gain.ts:263` (G1: kind in {undefined, "saved"} AND `savedBytes > 0`)
- `missedCount: number` — `record.kind === "missed"`
- `mostRecentTimestamp: string | null`
- `recentMissedRatio: number | null` — over most recent 50 records; `missedCount / (savedCount + missedCount)`; null if fewer than 50 records; records that are neither (e.g., legacy `savedBytes=0` and not explicitly missed) excluded from denominator (G1)
- `minimizerAppearsInactive: boolean` — `recentMissedRatio >= 0.98`
- `avgSavedRatio: number | null` (MN2) — `sum(savedBytes) / sum(inputBytes)` over savings records in the current scope; null if no savings records; surfaced for human eye, no enforced threshold
- `loadDurationMs: number` — duration of the file read + parse used to build this diagnostic
- `writeErrorCount: number`, `lastWriteError: {error, at} | null` (Shape α, T2)
- `readErrorCount: number`, `lastReadError: {error, at} | null` (Shape α, T2)
- `parseErrorCount: number`, `lastParseError: {error, lineNumber, at} | null` (MN1)
- `minimizerEnabled: boolean` — from settings `shellMinimizer` group
- `nativeBindingLoaded: boolean` — `typeof applyShellMinimizer === "function"`
- `cwdFilter: string` — exact cwd string used for current-scope filtering
- `distinctCwdsCount: number` — number of distinct cwds seen in the file
- `distinctCwdsSample: string[]` — up to 10 distinct cwds (pre-mortem scenario #2)

**Backwards-compat predicates (G1):**
- Aggregates tolerate missing/undefined optional fields.
- `isSavingsRecord` reused unchanged from `minimizer-gain.ts:263` — no new predicate forks.

**Acceptance:** T1 cases pass; T3 returns a single value per call; pure-ish (single fs read + status snapshot).

### T4 — Status tab in overlay + DualContext extension (G4, G5)

**File:** `packages/coding-agent/src/modes/components/minimizer-gain-overlay.ts`

**Work:**
- Extend `TABS` at line 11: `["Gain", "Missed"]` → `["Gain", "Missed", "Status"]`.
- Extend `DualContext` interface at lines 17–22 to include `diagnostic: MinimizerGainDiagnostic` (G5).
- Extend `LoadMinimizerGainContext` callsite in `showGainOverlay()` (`builtin-registry.ts:301-313`) to build the diagnostic inside the existing async `loadContext` closure. The synchronous `renderStatus` reads `this.#dualContext.diagnostic` (G5 — `renderStatus` cannot do async).
- Add `renderStatus(context, width)` returning labeled lines. Displays both `recordCount` and `recordCountInScope` (G6), `mostRecentTimestamp`, `loadDurationMs`, `fileSizeBytes`, error counters, `minimizerEnabled`, `nativeBindingLoaded`, `cwdFilter`, `distinctCwdsCount` (+ sample list when scope is empty but file is not), `avgSavedRatio`, `minimizerAppearsInactive` warning line.
- **Builder-throw fallback (G4):** if `buildMinimizerGainDiagnostic()` throws, the `loadContext` closure catches the throw and sets `diagnostic` to a sentinel `{ buildError: <message> }` shape; `renderStatus` detects the sentinel and renders single-line `Diagnostic error: <message>`. Increments `parseErrorCount` via Shape α. Gain/Missed tabs continue rendering from last-known `DualContext` (current refresh semantics preserved).
- Replace `catch {}` at lines 113–114 with the Shape α counter increment (MN3).

**Acceptance:**
- All existing overlay test cases in `test/modes/components/minimizer-gain-overlay.test.ts` remain unmodified and green (no fixed count asserted — M1).
- Optionally add 1–2 cases asserting the Status tab renders the diagnostic and the sentinel error path.

### T5 — Add `--diag` flag to `commands/gain.ts` (M2)

**File:** `packages/coding-agent/src/commands/gain.ts` (oclif `Flags`, not raw argv)

**Flag matrix (M2 explicit contract):**

| Invocation | Behavior |
|---|---|
| `omp gain` | unchanged — interactive overlay or text report (existing behavior) |
| `omp gain --json` | unchanged — existing `{records, summary, discovery, missed}` payload via `printJsonPayload` at `gain-cli.ts:99-113` |
| `omp gain --diag` | human-readable diagnostic table from `buildMinimizerGainDiagnostic()` |
| `omp gain --diag --json` | raw `buildMinimizerGainDiagnostic()` JSON to stdout |
| `omp gain --diag --discover` | error: `--diag cannot be combined with --discover/--missed/--all`; exit 2 |
| `omp gain --diag --missed` | same error; exit 2 |
| `omp gain --diag --all` | same error; exit 2 |
| `omp gain --diag --days <n>` | allowed — `--days` and `--cwd` feed into `recordCountInScope`, `recentMissedRatio` |
| `omp gain --diag --cwd <p>` | allowed |

**Flag definition:**

```ts
diag: Flags.boolean({ description: "Output diagnostic info instead of analytics", default: false })
```

**Exit codes (M2):**
- `0` — healthy
- `1` — any of: `writeErrorCount > 0`, `readErrorCount > 0`, `minimizerEnabled === false`, `nativeBindingLoaded === false` (use `process.exit(1)` consistent with `validateDays` style at `gain-cli.ts`)
- `2` — flag misuse (`--diag` + mutually exclusive flag)

**Acceptance:**
- `omp gain --diag --json | jq .recordsFilePath` returns a non-empty string in a clean env.
- `omp gain --diag --discover` exits 2 with the documented message.
- Exit `1` reproducible under simulated failure (T6).

**NOT in scope:** `/gain --diag` slash-command text-mode variant. Status tab covers the interactive surface.

### T6 — Extend `test/bash-executor.test.ts:168-260`

**Work (≤2 assertions added per case; no new test files):**
- Saved-path test (`168-210`): after the existing `savedBytes > 0` assertion, also assert `buildMinimizerGainDiagnostic({cwd})` reflects `recordCountInScope >= 1`, `savedCount >= 1`, and `mostRecentTimestamp` within 1s of the test's wall clock.
- Missed-path test (`212-260`) or sibling case: simulate a write failure by directing `recordMinimizerGain` at an unwritable path (use existing `vi.spyOn(piNatives.Shell.prototype, "run")` precedent; or chmod a tmp dir). Assert `getMinimizerGainStatus().writeErrorCount === 1` and `lastWriteError` non-null. Then call `runGainCommand` / `omp gain --diag` and assert exit 1 (M2 sub-assertion).
- Reset Shape α counters between test cases via `resetMinimizerGainStatusForTesting()` (T2-exported).

**Acceptance:**
- `bun test test/bash-executor.test.ts` passes.
- No new test files created (M1, G-existing-tests preserved).

### T7 — Build, run, and manually verify

**Commands (run from `packages/coding-agent`):**

```
bun run build
bun test
```

**Manual TUI verification:**
- Launch TUI; run `for i in $(seq 1 200); do echo "hello world $i"; done`; open `/gain`; switch to Status tab; confirm metrics.

**CLI verification:**

```
omp gain --diag
omp gain --diag --json | jq '.recordCount, .recordCountInScope, .mostRecentTimestamp, .writeErrorCount, .readErrorCount, .avgSavedRatio'
omp gain --diag --discover   # expect exit 2
omp gain --json              # expect unchanged existing payload
```

**Failure surfacing (G7 — directory-level chmod for cross-platform behavior):**

```
chmod 000 ~/.omp/agent && omp gain --diag --json   # expect readErrorCount >= 1, exit 1
chmod 700 ~/.omp/agent                              # restore
```

> Note (G7): on macOS, `chmod 000` on a file is bypassable by the owner in some contexts. Directory-level chmod is portable across Linux + macOS. Document this caveat in the test fixture.

---

## 8. Guardrails

### Must have
- All new code TypeScript, matching style in `packages/coding-agent`.
- No changes to JSONL on-disk format; backwards compatible with existing user data and legacy `kind=undefined` records (G1).
- Test runner: `bun test`. Test layout: `packages/coding-agent/test/<name>.test.ts`.
- Both write-side and read-side failures counted and surfaced via Shape α (T2, MN3).
- T0 completed and its observation recorded before T1 starts.
- Status tab + CLI `--diag` agree on counter values (single Shape α source).

### Must NOT have
- No SQLite, no ring buffer, no schema migration.
- No changes to the native `applyShellMinimizer` binding.
- No deletion or rotation of existing `~/.omp/agent/minimizer-gain.jsonl` outside the T0 pre-condition guard.
- No new dependencies in `package.json`.
- No new test files for paths already covered by `test/bash-executor.test.ts:168-260`.
- No `/gain --diag` slash-command text-mode variant.
- No fixed test-count assertions in success criteria (M1).
- No "decide at task start" deferrals of architectural decisions (M3 lesson).

---

## 9. Success Criteria (testable)

1. **T0 gate:** observation recorded with all six captures (G2); if regression detected, fix landed (or deferred per G3 time-box) before T3+.
2. Running a compressible command in the TUI increments the JSONL by 1 line and the overlay's Status tab reflects the new `recordCountInScope` within 1 refresh tick (1s).
3. `omp gain --diag --json` returns a JSON object with at minimum: `recordsFilePath`, `exists`, `fileSizeBytes`, `recordCount`, `recordCountInScope`, `savedCount`, `missedCount`, `mostRecentTimestamp`, `recentMissedRatio`, `avgSavedRatio`, `loadDurationMs`, `writeErrorCount`, `readErrorCount`, `parseErrorCount`, `minimizerEnabled`, `nativeBindingLoaded`, `cwdFilter`, `distinctCwdsCount`.
4. Forcing a read error (`chmod 000 ~/.omp/agent`) increments `readErrorCount`, surfaces a non-null `lastReadError`, and causes `omp gain --diag` to exit `1` (G7).
5. Forcing a write error increments `writeErrorCount` and surfaces a non-null `lastWriteError` (T6 assertion).
6. `omp gain --diag --discover` (and `--missed`, `--all`) exit `2` with the mutual-exclusion error (M2).
7. `omp gain --json` (without `--diag`) returns the existing `{records, summary, discovery, missed}` payload unchanged (M2 regression guard).
8. `bun test` passes; all existing cases in `minimizer-gain.test.ts`, `bash-executor.test.ts`, and `minimizer-gain-overlay.test.ts` remain unmodified and green (no fixed count — M1).

---

## 10. Expanded Test Plan (deliberate mode)

### Unit (extensions only)
- `buildMinimizerGainDiagnostic`: empty file, mixed records, 100% missed window, legacy `kind=undefined` saved records counted via `isSavingsRecord` (G1), `distinctCwdsSample` cap, `recentMissedRatio` threshold, `avgSavedRatio` in `[0,1]` (MN2), null when no savings records.
- I/O failure surfacing (Shape α, T2): write/read/parse failures each route to their counter + last-error; `resetMinimizerGainStatusForTesting` clears between cases.
- Builder-throw fallback (G4): simulated throw inside `buildMinimizerGainDiagnostic` does not propagate to overlay refresh.

### Integration (extensions only)
- `test/bash-executor.test.ts:168-210` + assertion: diagnostic reflects freshly-written saved record.
- `test/bash-executor.test.ts:212-260` (or sibling case) + assertion: simulated write failure increments diagnostic counter; `runGainCommand --diag` returns exit 1.

### CLI flag matrix (M2)
- `omp gain` unchanged.
- `omp gain --json` unchanged payload shape.
- `omp gain --diag` table output.
- `omp gain --diag --json` JSON diagnostic.
- `omp gain --diag --discover|--missed|--all` exit 2.

### E2E (manual; documented; not automated)
- Launch TUI, run compressible loop, open `/gain`, switch to Status tab, verify metrics.
- Toggle `shellMinimizer` off in settings; rerun a command; confirm `minimizerEnabled === false` in diagnostic.
- Cross-platform chmod test (G7): directory-level on macOS + Linux.

### Observability (delivered via diagnostic surface, not logs)
- `loadDurationMs`, `fileSizeBytes`, `avgSavedRatio` on every diagnostic call. These are the trigger metrics for Option B + the quality-regression early-warning.

---

## 11. Verification Steps (concrete commands)

Run from `/Users/davidandrews/PycharmProjects/lex/packages/coding-agent`:

```
# Build
bun run build

# Tests
bun test
bun test test/minimizer-gain.test.ts
bun test test/bash-executor.test.ts
bun test test/modes/components/minimizer-gain-overlay.test.ts

# Manual TUI verification
# 1. Launch TUI
# 2. for i in $(seq 1 200); do echo "hello world $i"; done
# 3. /gain  → Status tab
# 4. Confirm recordCountInScope > 0, mostRecentTimestamp recent, minimizerAppearsInactive=false

# CLI verification
omp gain --diag
omp gain --diag --json | jq '.recordCount, .recordCountInScope, .mostRecentTimestamp, .writeErrorCount, .readErrorCount, .avgSavedRatio'
omp gain --diag --discover   # expect exit 2
omp gain --json              # expect unchanged existing payload

# Failure surfacing (G7 directory-level chmod)
chmod 000 ~/.omp/agent && omp gain --diag --json
chmod 700 ~/.omp/agent
```

---

## 12. ADR

### Decision
Adopt **Option A — Diagnostic-first** for the `/gain` slash command, gated by a **T0 reproduction step**. Add `buildMinimizerGainDiagnostic()`, surface I/O failures via **Shape α (module-level counters in `minimizer-gain.ts`, locked rev 3)**, expose the diagnostic via a new **Status tab in the existing overlay** (with `DualContext` extension) and via **`omp gain --diag [--json]`** as a new oclif `Flags.boolean` on `commands/gain.ts`. Extend existing tests; no new test files. Instrumentation (`loadDurationMs`, `fileSizeBytes`, `avgSavedRatio`) lives in the diagnostic surface, not in debug logs.

### Drivers
1. User trust — Status tab + CLI JSON answer "is it working?" in one action.
2. Runtime cost under long sessions — currently unmeasured; Option A surfaces the metrics that decide Option B later.
3. Extend, don't duplicate existing tests — substantial coverage already exists.

### Alternatives considered
- **Status row above tabs vs Status tab.** Tab wins: reuses existing refresh loop, no width-guard branching.
- **`/gain --diag` text-mode slash variant vs CLI-only.** CLI-only wins: Status tab covers interactive surface; CLI `--diag --json` covers CI smoke testing.
- **Shape α (module-level counter) vs Shape β (return value plumbed through `bash-executor.ts`).** **α chosen.** Shape β's "no global singleton" claim is undermined by `brokenShellSessions` precedent at `bash-executor.ts:60`, which is itself a module-level singleton. α has smaller blast radius (1 file vs 2 + 8 call sites) and lets T3 read counters directly. Rev 2's "decide at T2 start" deferral was an architectural decision in disguise; rev 3 locks it now.
- **`omp gain --diag` as raw argv parse vs new oclif `Flags.boolean`.** oclif `Flags` chosen — matches existing `Gain.flags` pattern in `commands/gain.ts:12-22` and gives free `--help` integration.
- **Embedding `--diag` payload inside existing `omp gain --json` vs separate flag.** Separate flag chosen — keeps `omp gain --json` payload stable for any existing consumer.
- **Skip T0 vs reproduce-first.** Reproduce-first wins: recent gain-area churn means diagnostic-on-top-of-regression would be confidence laundering.
- **Option B (perf) now vs later.** Later: no measurement justifies it.
- **Option C (rewrite).** Invalidated: violates Principles 3 and 5.

### Why chosen
- T0 gate + bisect time-box (G3) prevents building observability on top of a regression while bounding wall-clock risk.
- Status tab reuses the existing 1s refresh loop; `DualContext` extension (G5) keeps `renderStatus` synchronous.
- CLI `--diag` lives as an oclif flag; existing `--json` payload unchanged → no regression for downstream consumers (M2).
- Shape α (M3) collapses the diagnostic plumbing to module-local reads.
- File-wide `recordCount` + `recordCountInScope` (G6) means the Status tab answers both "is anything happening at all?" and "does my current scope see it?".
- `avgSavedRatio` (MN2) and `lastParseError` (MN1) close pre-mortem scenario #1 (quality regression) and complete the error-surface symmetry.

### Consequences
- Positive: users get a one-action "is it working?" answer (Status tab or `omp gain --diag`). Failures stop being silent. Quality regressions visible via `avgSavedRatio`. Regression risk caught early (T0).
- Negative: small scope expansion (T0 reproduction, builder-throw fallback). CLI gains a flag and a documented exit-code contract.
- Neutral: overlay gains one tab.
- **Rollback (G8):** if T2 counters introduce regression, revert T2 only. T3 falls back to stub zero-counters (`writeErrorCount = 0`, errors null); T4 Status tab + T5 CLI remain functional with degraded fidelity (no write/read error tracking). T1/T6 assertions on counters skip via `if (typeof getMinimizerGainStatus === "function")` guard.

### Follow-ups
1. If T0 reveals a regression: bisect `338908863..HEAD` or defer per G3.
2. After 1–2 weeks of field usage, review `loadDurationMs`, `fileSizeBytes`, `avgSavedRatio` distributions surfaced by the diagnostic. If sustained `fileSizeBytes > 10 MB` or `loadDurationMs` p95 > 50 ms, open Option B (tail-streaming + rotation).
3. Consider `omp gain --truncate` (or `--rotate`) if users report large files.
4. Tune `recentMissedRatio` threshold (current 0.98) once real data is available.
5. Decide whether `avgSavedRatio` becomes a hard threshold (MN2) — needs field data.

---

## 13. Open Questions (track in `.omc/plans/open-questions.md`)

Open:
- T0 reproduction outcome — gates branch decision (regression-fix branch vs T1–T7 as written).
- Whether `avgSavedRatio` (MN2) becomes a hard threshold later — data needed first.

Resolved (rev 3):
- ~~Test runner~~ → `bun:test`.
- ~~Test layout~~ → `packages/coding-agent/test/<name>.test.ts`.
- ~~Error counter shape~~ → **Shape α** (M3).
- ~~Native binding probe~~ → `typeof applyShellMinimizer === "function"`.
- ~~CI exit-code contract~~ → 0 healthy / 1 I/O or feature-off / 2 flag misuse (M2).
- ~~`omp gain --json` regression risk~~ → flag matrix preserves existing payload (M2).
- ~~Existing test counts in success criteria~~ → removed; assertions now count-free (M1).

---

**Approval gate:** This plan is `pending approval`. Do not execute. On approval, hand off to `/oh-my-claudecode:start-work gain-slash-remediation`.

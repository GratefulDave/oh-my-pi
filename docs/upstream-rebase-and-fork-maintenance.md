# Fork Maintenance Guide — GratefulDave/oh-my-pi (lex fork)

> **Canonical workflow**: `git merge upstream/main` → resolve conflicts → `./rebuild-lex.zsh`
> `rebuild-lex.zsh` changes only the binary/native cache by default. Existing extensions,
> extension registrations, profiles, and user settings remain untouched.
> Extension rebuild/install requires explicit `LEX_REBUILD_EXTENSIONS=1 LEX_ALLOW_EXTENSION_STATE_CHANGE=1`.
> This doc replaces the stale rebase-based procedure. All PRs were merged upstream; the fork now
> carries only the patches listed in §3.

Fork-maintenance helpers live in the sibling `../lex-maintenance` repository; override that location with `LEX_MAINTENANCE_HOME`.

---

## 1. Remotes & branches

```
origin    git@github.com:GratefulDave/oh-my-pi.git   # fork (push here)
upstream  https://github.com/can1357/oh-my-pi.git    # fetch only
```

| Branch | Role |
|--------|------|
| `upstream-16.3.2` | current main lane (HEAD) |
| `upstream-16.3.0` | prior release lane (`lex-prev` worktree) |

3-lane layout:
- `~/PycharmProjects/lex` — current release lane
- `~/PycharmProjects/lex-prev` — prior release lane (read-only reference)
- `~/PycharmProjects/lex-<pr>` — per-PR worktrees (transient)

---

## 2. Routine upstream sync

```bash
cd ~/PycharmProjects/lex
git fetch upstream
git stash                           # if dirty
git merge upstream/main             # merge, not rebase — preserves fork commit history
```

**Conflict hot zones** (always expected):
- `bun.lock` — always take upstream: `git checkout --theirs bun.lock && bun install`
- `packages/*/CHANGELOG.md` — keep both sections; upstream goes in released section

After a clean merge:
```bash
./rebuild-lex.zsh
```

This is a binary-only rebuild. It preserves existing global extension bundles, symlink targets,
registrations, profiles, and user settings. To intentionally rebuild/install extensions:
```bash
LEX_REBUILD_EXTENSIONS=1 LEX_ALLOW_EXTENSION_STATE_CHANGE=1 ./rebuild-lex.zsh
```

After a successful rebuild, run the patch checker to confirm all fork patches survived:
```bash
bun "${LEX_MAINTENANCE_HOME:-../lex-maintenance}/scripts/check-fork-patches.ts" --repo "$PWD"
```

---

## 3. Active fork-only patches

These are changes that exist in this fork but NOT in upstream `can1357/oh-my-pi`. They must be
re-verified after every merge. The `check-fork-patches.ts` script does this automatically.

### Patch 1: `replaceModelRoles` (profile-manager profile switch)

**Why**: `overrideModelRoles` is additive (merges into existing roles). Profile switches need to
*replace* the entire role map, not accumulate. Upstream only has the additive version.

**Files**:
- `packages/coding-agent/src/config/settings.ts` — `replaceModelRoles()` method
- `packages/coding-agent/src/extensibility/extensions/types.ts` — `replaceModelRoles` in `ExtensionAPI` + `ExtensionActions`
- `packages/coding-agent/src/extensibility/extensions/loader.ts` — stub + real impl
- `packages/coding-agent/src/extensibility/extensions/runner.ts` — wired to actions
- `packages/coding-agent/src/modes/runtime-init.ts` — wired to session.settings
- `packages/coding-agent/src/modes/acp/acp-agent.ts` — wired
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — wired (×2)
- `packages/coding-agent/src/task/executor.ts` — wired

**Verify**: `grep -r 'replaceModelRoles' packages/coding-agent/src/ | wc -l` should be ≥ 8.

**Conflict risk**: any upstream refactor of `overrideModelRoles` wiring touches the same sites.
Pattern: wherever `overrideModelRoles` is wired, `replaceModelRoles` must be wired in parallel.

---

### Patch 2: `bash.ts` env type widening (`Record<string, unknown>`)

**Why**: `formatBashEnvAssignments` / `getBashEnvForDisplay` / `resolveEnv` typed as
`Record<string, string>` upstream, but env values may arrive as non-string (number, boolean)
from some extension providers. Widening to `unknown` + `String(value)` prevents a runtime crash.

**Files**:
- `packages/coding-agent/src/tools/bash.ts`

**Verify**: `grep 'unknown' packages/coding-agent/src/tools/bash.ts | grep -c 'Record'` → 3.

**Conflict risk**: low — upstream is unlikely to change this signature; if it does, re-apply widening.

---

### Patch 3: Subagent HUD — spinner, settle summary, activity rows

**Why**: Upstream's subagent HUD is a static tree (no spinner, no post-completion summary message).
This fork adds: (a) themed spinner frames synced to `sharedSpinnerFrame`, (b) per-row activity
line showing current tool / recent output / last tool, (c) on-settle emitting a
`subagent-hud-summary` custom message into the chat transcript so completed agent stats scroll away.

**Files**:
- `packages/coding-agent/src/modes/interactive-mode.ts` — `renderSubagentHudLines()` rewrite, `#startSubagentSpinner()`, `#stopSubagentSpinner()`, settle detection, `#hadActiveSubagents`, `#emittedSubagentSummaryIds`, `#subagentSpinnerFrame`
- `packages/coding-agent/src/modes/utils/transcript-render-helpers.ts` — `SUBAGENT_HUD_SUMMARY_MESSAGE_TYPE`, `SubagentHudSummaryRow`, `SubagentHudSummaryDetails`, `buildSubagentHudSummaryBlock()`
- `packages/coding-agent/src/modes/components/chat-transcript-builder.ts` — renders `subagent-hud-summary` custom messages
- `packages/coding-agent/src/modes/utils/ui-helpers.ts` — renders `subagent-hud-summary` in transcript rebuild

**Verify**: `grep -c 'SUBAGENT_HUD_SUMMARY' packages/coding-agent/src/modes/utils/transcript-render-helpers.ts` → ≥ 1.

**Conflict risk**: HIGH — upstream frequently refactors the HUD / interactive-mode. On every merge,
diff `interactive-mode.ts` carefully. The spinner and settle-detection logic lives inside
`#renderSubagentList()` and the session update handler; upstream may refactor those methods.

---

### Patch 4: `status-line.ts` — `metaColor` option

**Why**: Allows callers to override the meta text color (default `"dim"`) for subagent status rows
that need accent or error coloring.

**Files**:
- `packages/coding-agent/src/tui/status-line.ts`

**Verify**: `grep -c 'metaColor' packages/coding-agent/src/tui/status-line.ts` → ≥ 2.

**Conflict risk**: low — additive option, unlikely to conflict unless upstream rewrites status-line.

---

### Patch 5: `sdk.ts` — extension preload inheritance in eval-spawned subagents

**Why**: Without this, eval-spawned subagents re-run extension discovery on the shared registry
and double-register providers. The fix exposes `getPreloadedExtensions()` and passes the result
to subagent SDK construction so already-loaded extensions are inherited rather than re-discovered.

**Files**:
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/task/executor.ts` — `preloadedExtensions` option threaded through

**Verify**: `grep -c 'getPreloadedExtensions\|preloadedExtensions' packages/coding-agent/src/sdk.ts` → ≥ 2.

**Conflict risk**: medium — sdk.ts is frequently modified upstream.

---

### Patch 6: `task/disabled-agents.ts` — `isAlwaysEnabledAgent()`

**Why**: Certain agents (e.g. `task`) must never be disabled by `enabledAgents` filters. This
utility guards the filter to always pass `task` through.

**Files**:
- `packages/coding-agent/src/task/disabled-agents.ts` (new file, fork-only)

**Verify**: file exists: `ls packages/coding-agent/src/task/disabled-agents.ts`.

**Conflict risk**: low — new file, no upstream collision unless upstream adds same name.

---

### Patch 7: `natives/scripts/build-native.ts` — macOS Homebrew rustc PATH fix

**Why**: Homebrew installs its own `rustc`/`cargo` (stable channel) at `/opt/homebrew/bin/` which
appears before `~/.cargo/bin` in the default macOS PATH. Rustup shims are bypassed — the nightly
toolchain in `rust-toolchain.toml` is never activated — causing `E0554` (feature on stable).
Fix: at script startup, read `rust-toolchain.toml`, find the matching nightly toolchain bin dir,
and prepend it to `process.env.PATH` so all child spawns (cargo metadata, napi build) use nightly.

**Files**:
- `packages/natives/scripts/build-native.ts`

**Verify**: `grep -c 'toolchainBin\|rustup' packages/natives/scripts/build-native.ts` → ≥ 4.

**Conflict risk**: low — upstream is unlikely to touch this script's preamble. If upstream replaces
this script, re-apply the nightly PATH prepend block at the top of the new version.

---

### Patch 8: Automatic agents use OpenAI Codex

**Why**: Automatic task and Vibe agents must never spend OpenRouter credits, regardless of the
active model profile or an agent definition's fallback chain. OpenRouter Claude-family selectors
map to comparable OpenAI Codex models at `auto` effort:

- Opus → `openai-codex/gpt-5.6-sol:auto`
- Sonnet → `openai-codex/gpt-5.6-terra:auto`
- Haiku → `openai-codex/gpt-5.6-luna:auto`
- Unknown OpenRouter automatic agent → `openai-codex/gpt-5.6-terra:auto`

Explicit per-call model requests remain explicit overrides. The external maintenance rebuild runs
`set-agent-codex-defaults.ts`, which writes fixed Codex defaults into canonical and isolated
`.omp`/`.lex` profile configs without changing credentials or unrelated settings.

**Files**:
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/src/vibe/runtime.ts`
- `../lex-maintenance/scripts/set-agent-codex-defaults.ts`
- `rebuild-lex.zsh` — external-tool launcher

**Verify**:
- `bun test packages/coding-agent/test/task/executor-subagent-reminders.test.ts`
- `bun "${LEX_MAINTENANCE_HOME:-../lex-maintenance}/scripts/set-agent-codex-defaults.test.ts"`
- `bun "${LEX_MAINTENANCE_HOME:-../lex-maintenance}/scripts/check-fork-patches.ts" --repo "$PWD"`

**Conflict risk**: medium — upstream task-routing changes can touch the same executor paths. The
fork checker rejects a rebuild if any mapping, provider exclusion, task/Vibe enforcement, or
rebuild normalization hook disappears.

---

### Patch 9: External maintenance tooling

Fork-maintenance tooling lives outside this upstream-facing checkout:
- `../lex-maintenance/scripts/rebuild-lex.zsh` — rebuild implementation and extension-state guard
- `../lex-maintenance/scripts/check-fork-patches.ts` — post-merge runtime patch checker
- `../lex-maintenance/scripts/update-from-upstream.sh` — upstream synchronization
- `../lex-maintenance/scripts/sync-versions.ts` — fork version stamp
- `../lex-maintenance/scripts/check-lex-auth.sh` and `../lex-maintenance/scripts/sync-pi-to-lex-auth.py` — local auth maintenance

The Lex checkout retains only the `rebuild-lex.zsh` launcher and runtime/product patches.

---

## 4. Post-merge checklist

After every `git merge upstream/main`:

1. **Check patch integrity**: `bun "${LEX_MAINTENANCE_HOME:-../lex-maintenance}/scripts/check-fork-patches.ts" --repo "$PWD"`
   — reports any patch that no longer applies (method removed, file replaced, grep miss)
2. **Conflict hot zone review**: `git diff upstream/main HEAD -- packages/coding-agent/src/modes/interactive-mode.ts | head -50`
   — if the subagent HUD region changed upstream, re-verify Patch 3
3. **`bun check`** — catches type errors from upstream API changes
4. **`./rebuild-lex.zsh`** — binary/native build + extension-state preservation guard
5. **Optional extension rebuild** — only with both explicit opt-in environment variables
6. **Live test**: start lex, run `/pm use ag`, open `/models` — should show only `ag/*` models

---

## 5. Build reference

| Task | Command |
|------|---------|
| Binary/native build + install | `./rebuild-lex.zsh` |
| Explicit extension rebuild/install | `LEX_REBUILD_EXTENSIONS=1 LEX_ALLOW_EXTENSION_STATE_CHANGE=1 ./rebuild-lex.zsh` |
| TS type check | `bun check` |
| Native only | `bun --cwd=packages/natives run build` |
| Verify fork patches | `bun "${LEX_MAINTENANCE_HOME:-../lex-maintenance}/scripts/check-fork-patches.ts" --repo "$PWD"` |
| All TS tests | `bun test` |
| Single package tests | `bun test packages/coding-agent/test/<file>.test.ts` |
| Sync fork version stamp | `bun "${LEX_MAINTENANCE_HOME:-../lex-maintenance}/scripts/sync-versions.ts" <version>` |
| Upgrade profile-manager | `bun build .omp/extensions/profile-manager/index.ts --outfile .omp/extensions/profile-manager/dist/index.js --target bun --format esm` |

---

## 6. Extension layout

```
~/.omp/agent/extensions/
  profile-manager/profile-manager.bundle.js    # from .omp/extensions/profile-manager
  profile-manager/index.js -> profile-manager.bundle.js   # symlink (rebuild-lex.zsh creates)
  [personal extensions...]                     # from ~/PycharmProjects/omp-personal-extensions
```

The `profile-manager` extension is **not** a workspace package — it lives in
`.omp/extensions/profile-manager/`. `rebuild-lex.zsh` builds it with a direct `bun build` call
and restores the `index.js` symlink that `install-user-extensions.ts` removes.

Personal extensions (`omp-personal-extensions`) are rebuilt and installed by `rebuild-lex.zsh`
after the workspace build. They run `bun run build && bun run install:user`.

---

## 7. NAPI native sentinel

The native addon export name must match the version in `packages/natives/package.json`. The sentinel
`__piNativesV{version}` guards against loading a stale cached addon. `rebuild-lex.zsh` runs
`perl -pi -e` to update it in `crates/pi-natives/src/lib.rs`, `native/index.js`, and
`native/index.d.ts` before building. If upstream changes the sentinel mechanism, update the `perl`
invocation in `rebuild-lex.zsh`.

---

## 8. Protected files

`rebuild-lex.zsh` hash-guards these files and refuses to finish if they change:
- `~/.omp/agent/config.yml`
- `~/.lex/agent/config.yml`

Never edit these from code. Change them manually, then re-run `rebuild-lex.zsh`.

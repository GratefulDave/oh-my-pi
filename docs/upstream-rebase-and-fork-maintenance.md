# Upstream Rebase & Fork Maintenance (Lex Fork)

What to do when upstream `can1357/oh-my-pi` moves — and specifically **how to carry the native
changes if our 6 PRs are NOT accepted**.

Extensions are handled separately and survive pulls untouched — see
[`extensions-build-and-test.md`](./extensions-build-and-test.md). This doc is about the
**Rust/native** layer that cannot be an extension.

---

## 1. Remotes & branches

```
origin    git@github.com:GratefulDave/oh-my-pi.git   # the Lex fork (push here)
upstream  https://github.com/can1357/oh-my-pi.git    # upstream (fetch only)
```

| Branch | Role |
|--------|------|
| `main` | fork baseline, tracks upstream |
| `wip/lex-binary-extraction` | current working branch (extensions, `15.7.3-lex` stamp, fork tooling) |
| `fix/subagent-propagation` | fork-only AG subagent fix |
| `pr/minimizer-chain` | **PR #1637** (pi-shell chain segmentation) |
| `pr/minimizer-filters` | **PR #1638** (pi-shell git/cloud/docker/listing/pkg/bun/cargo filters) |
| `pr/minimizer-new-filters` | **PR #1639** (pi-shell AI/binary/rust tool filters) |
| `pr/keys-legacy-fix` | **PR #1640** (pi-natives key matching) |
| `pr/brush-pipeline-fix` | **PR #1641** (brush-core pipeline EPERM) |
| `pr/shell-minimizer-binding` | **PR #1642** (pi-natives NAPI minimizer binding) |

Every `pr/*` branch is built on `upstream/main` with a focused diff (fork artifacts stripped) so
each compiles standalone for upstream.

---

## 2. Routine upstream sync (PRs accepted or not)

```bash
./scripts/update-from-upstream.sh
```
What it does (`scripts/update-from-upstream.sh`):
1. `git fetch upstream`
2. stashes a dirty tree if present (`auto-stash before upstream rebase <ts>`)
3. `git rebase upstream/main` on the **current** branch
4. on conflict: **pauses**, prints recovery steps, exits 1 (non-destructive)
5. on success: `git stash pop` (warns if the pop conflicts)

After a clean rebase:
```bash
git rebase --continue        # only if it paused
git stash pop                # only if it stashed and didn't auto-pop
./rebuild-lex.zsh
```

Run it **on the branch you want updated** (`git checkout wip/lex-binary-extraction` first).

---

## 3. Rebuild the lex binary

```bash
./rebuild-lex.zsh
```
What it does (`rebuild-lex.zsh`):
1. `bun install`
2. `bun run build` — workspace TS build **+** NAPI native build (cargo → `pi_natives` addon)
3. asserts `packages/coding-agent/dist/omp` exists & is executable
4. symlinks it to `~/.local/bin/lex`, ensures `~/.local/bin` is on `$PATH` in `~/.zshrc`
5. prints `lex --version`

For the current shell after a rebuild: `source ~/.zshrc && hash -r`.

Native-only rebuild (faster when you only touched Rust):
```bash
bun run build:native        # = bun --cwd=packages/natives run build
```

---

## 4. IF THE 6 PRs ARE REJECTED — carry the native changes on the fork

The PR branches are scoped for upstream. If upstream declines them, the work must persist on the
fork's own line and ride every future upstream rebase. Procedure:

### 4.1 Create a durable fork-native branch
```bash
git fetch upstream
git checkout main
git rebase upstream/main          # bring fork baseline current
git checkout -b feature/fork-native-minimizer main
```

### 4.2 Stack the rejected PR commits onto it
Cherry-pick in dependency order (filters/bindings build on the chain + native surface):
```bash
git cherry-pick origin/pr/minimizer-chain~1..origin/pr/minimizer-chain        # #1637
git cherry-pick origin/pr/minimizer-filters~1..origin/pr/minimizer-filters    # #1638
git cherry-pick origin/pr/minimizer-new-filters~1..origin/pr/minimizer-new-filters  # #1639
git cherry-pick origin/pr/keys-legacy-fix~1..origin/pr/keys-legacy-fix        # #1640
git cherry-pick origin/pr/brush-pipeline-fix~1..origin/pr/brush-pipeline-fix  # #1641
git cherry-pick origin/pr/shell-minimizer-binding~1..origin/pr/shell-minimizer-binding  # #1642
```
> Use the `~1..branch` range so you pick **all** commits on each branch (each carries the original
> change + its Codex-review fixups), not just the tip. Adjust `~N` to the commit count per branch
> (chain/filters/keys/brush = 2 each, shell-minimizer = 3).

Resolve conflicts as they arise (most likely in `crates/pi-shell/src/minimizer/filters/*`).

### 4.3 Re-stamp the fork version
```bash
bun scripts/sync-versions.ts 15.7.3-lex
git add -A && git commit -m "chore: re-stamp 15.7.3-lex after carrying native PRs onto fork"
```
`sync-versions.ts` updates every `package.json`, the root catalog, and the `pi-natives` NAPI
version sentinels (`__piNativesV15_7_3_lex` in `crates/pi-natives/src/lib.rs`,
`packages/natives/native/index.{js,d.ts}`). The sentinel guards against a JS↔native version
mismatch at load time — keep it in lockstep after every rebase.

### 4.4 Rebuild + verify, then merge into the working line
```bash
./rebuild-lex.zsh
lex --version
git checkout wip/lex-binary-extraction
git merge feature/fork-native-minimizer          # or rebase
git push origin wip/lex-binary-extraction feature/fork-native-minimizer
```

### 4.5 Re-apply the fork artifacts stripped for upstream
The PR branches deliberately **omit** Lex-private pieces. When carrying onto the fork, restore them:
- the `rebuild-lex.zsh` minimizer filter in `crates/pi-shell/src/minimizer/filters/bun.rs`
  (`LEX_REBUILD_SCRIPT`, `filter_rebuild_lex`, `is_rebuild_lex_noise`) + its dispatch arms in
  `filters/mod.rs` — this is fork-only and was the reason #1638/#1639 are flagged for upstream.
- any `_lex` suffixes / sibling-PR cross-refs that were scrubbed.

> Keep these on the fork branch only. They must **never** re-enter a `pr/*` branch.

---

## 5. IF A SUBSET IS ACCEPTED

For each merged PR, drop its cherry-pick from §4.2 — once it lands in `upstream/main`, the routine
rebase (§2) brings it in. Cherry-pick only the **still-rejected** branches. After the next
`update-from-upstream.sh`, delete the merged `pr/*` branches:
```bash
git push origin --delete pr/<merged-branch>
git branch -D pr/<merged-branch>
```

---

## 6. Conflict hot zones (historical)

- `packages/ai/src/models.json` — upstream renames/deletes vs fork-retained tools.
- `packages/coding-agent/src/**` — actor system, factory, observer overhaul.
- `crates/pi-shell/src/minimizer/**` — large fork expansion; the biggest cherry-pick conflict risk.
- `Cargo.lock`, `bun.lock` — regenerate rather than hand-merge: `bun install`, `cargo build`.

### NAPI surface freeze (PR #1642)
The minimizer binding's surface is frozen and must not drift across rebases:
```
applyShellMinimizer(options: ShellMinimizerApplyOptions): MinimizerResult | null
ShellMinimizerApplyOptions { command, captured, exitCode?, minimizer? }
errors thrown as napi::Error
```
If a rebase touches `crates/pi-natives/src/shell.rs` or the generated bindings, re-verify this
signature and regenerate `packages/natives/native/index.d.ts`.

---

## 7. Build/test/lint reference

| Task | Command |
|------|---------|
| Full build (TS + native) | `bun run build` |
| Native only | `bun run build:native` |
| Rebuild + install `lex` | `./rebuild-lex.zsh` |
| Scoped Rust check (fast) | `cargo check -p pi-shell` / `-p pi-natives` |
| Rust tests (scoped) | `cargo test -p pi-shell -- <test>` |
| All tests | `bun run test` (`test:ts` ‖ `test:rs`) |
| Lint | `bun run lint` |
| Sync/stamp version | `bun scripts/sync-versions.ts 15.7.3-lex` |

> Cold `cargo`/`clippy` builds are slow — prefer `cargo check -p <crate>` while iterating, and
> commit+push immediately after a successful build.

# Rebase Playbook When Upstream PR Acceptance Is Uncertain

Use this when syncing the Lex fork with `can1357/oh-my-pi/main` while PRs such as #1750 may or may not be accepted upstream.

## Core rule

Do not replay work that upstream already accepted. First classify each PR, then sync/replay only the missing fork deltas.

## 1. Start clean

Before any sync/rebase:

```bash
git status --short --branch
```

If there is local work, commit it or stash it first:

```bash
git stash push -u -m 'pre-upstream-sync'
```

Do not run a deep rebase with a dirty tree.

## 2. Fetch and classify PRs

```bash
git fetch upstream origin --prune
```

Check each PR manually in GitHub or with `gh`:

```bash
gh pr view 1750 --repo can1357/oh-my-pi --json state,mergedAt,headRefName,mergeCommit
gh pr view 1640 --repo can1357/oh-my-pi --json state,mergedAt,headRefName,mergeCommit
```

Classify each PR:

| PR state | Action |
| --- | --- |
| Merged into upstream | Do not cherry-pick/replay that branch. Let `upstream/main` bring it in. |
| Closed unmerged / rejected | Replay only the still-needed diff onto the fork sync branch. |
| Still open | Do not assume. Either wait, or replay only if you need the fork to carry it before upstream decides. |

For #1750 specifically:

- If accepted: skip `pr/minimizer-consolidated` and the old split minimizer branches `#1637/#1638/#1639/#1642`.
- If rejected: replay the native minimizer work onto the fork line.
- If partially accepted or squashed with edits: compare upstream state first; replay only missing fixes.

For #1640:

- If accepted: skip `pr/keys-legacy-fix`.
- If rejected: replay only that still-missing native key fix.

## 3. Avoid literal rebases of deep fork branches

Do not blindly run `git rebase upstream/main` on deep fork lines such as `wip/lex-binary-extraction`. They can be thousands of commits apart and create a conflict storm.

Measure divergence before choosing a strategy:

```bash
git rev-list --left-right --count upstream/main...HEAD
```

Use literal rebase only for small upstream-based PR/work branches. For deep fork syncs, prefer a fresh upstream-based branch and replay only the fork deltas you still need.

## 4. Fresh sync branch pattern

```bash
git switch -c sync/upstream-YYYY-MM-DD upstream/main
```

Then replay only missing fork-private or rejected-PR deltas. For a rejected PR branch:

```bash
mb=$(git merge-base upstream/main pr/<branch>)
git cherry-pick -n "$mb"..pr/<branch>
# resolve conflicts
git add <resolved paths>
git commit
```

If a PR was accepted, do not cherry-pick it. Upstream already owns that code.

## 5. Fork-only artifacts to restore only on fork branches

Keep these out of upstream PR branches:

- `rebuild-lex.zsh`
- `.omp/settings.json`
- `.omp/extensions/**`
- local extension packages and bundles
- fork docs/scripts such as extension install helpers
- Lex-only `_lex` version stamps or suffixes
- Antigravity/fork-private provider code that upstream did not accept
- any rebuild-lex minimizer filter or dispatch arm stripped from upstream PRs

## 6. Conflict hot zones

Expect conflicts around:

- `crates/pi-shell/src/minimizer/**`
- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/keys.rs`
- `packages/natives/native/index.js`
- `packages/natives/native/index.d.ts`
- `Cargo.toml`, `Cargo.lock`
- `bun.lock`
- `packages/coding-agent/src/**`

For lockfiles, prefer regenerating with the package manager/build instead of hand-merging large conflict blocks.

## 7. Native/version sentinel check

After native changes or a version restamp, keep package versions and N-API sentinel exports aligned:

- `crates/pi-natives/src/lib.rs`
- `packages/natives/native/index.js`
- `packages/natives/native/index.d.ts`
- package versions / root catalog entries

Use:

```bash
bun scripts/sync-versions.ts <version>
```

Then rebuild:

```bash
./rebuild-lex.zsh
```

`rebuild-lex.zsh` runs install/build, creates `packages/coding-agent/dist/omp`, links it to `~/.local/bin/lex`, and prints `lex --version`.

## 8. Extension rebuilds after sync

Extensions survive upstream binary replacement because they load from bundles in settings. Source edits still require rebundling and a process restart.

Rebuild touched extensions:

```bash
bun --cwd=packages/pi-observer run build
bun --cwd=packages/pi-minimizer-gain run build
```

Install globally if you want `lex` to load them from any cwd:

```bash
bun scripts/install-user-extensions.ts --dry-run
bun scripts/install-user-extensions.ts
```

Restart `lex` / `omp`; extensions load at startup.

Verify:

- `/observe` or Ctrl-S opens observer.
- `/gain view` loads minimizer gain data.
- startup logs contain no extension load errors.

## 9. Verification after sync

Minimum checks depend on touched areas:

```bash
cargo check -p pi-shell
cargo check -p pi-natives
bun --cwd=packages/pi-observer run check
bun --cwd=packages/pi-minimizer-gain run check
./rebuild-lex.zsh
```

For #1750/native minimizer fixes, run focused Rust regressions for the changed behavior before broader checks.

## 10. Known doc drift

`docs/upstream-rebase-and-fork-maintenance.md` mentions `scripts/update-from-upstream.sh`, but that script is absent in this checkout. Use the explicit fetch/classify/fresh-branch flow above unless the script is restored and verified.

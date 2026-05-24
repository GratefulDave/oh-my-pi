Best safe OMP improvements from rtk review:

P0 — do these first

1.  git status: preserve repo operation state

- Gap: OMP condenses branch/files but misses rebase/merge/cherry-pick/bisect/am/sparse-checkout state.
- Safe output:
  - state: rebase in progress
  - state: merge in progress. unresolved conflicts
  - then normal status summary.
- Why safe: adds missing critical context; does not remove file list.

2.  grep / rg: center truncation around match

- Gap: OMP truncates long match lines from start; match can disappear.
- rtk centers around match.
- Safe output:
  - file.ts:42: ...before MATCH after...
- Why safe: preserves actual match + nearby context, less noise.

3.  git show: structured commit+stat+diff compaction

- Gap: OMP uses head/tail for git show.
- Safe output:
  - commit summary + message body
  - stat summary
  - compact hunk samples via existing condense_diff
- Keep blob show (git show HEAD:path) passthrough.

4.  git pull: summarize success

- Gap: OMP dedup/head-tail.
- Safe output:
  - ok (up-to-date)
  - ok 3 files +10 -2
- Failure/conflicts stay verbatim.

5.  Artifact tail-offset hints

- Gap: OMP gives [raw output: artifact://id], but no pointer to hidden tail/list continuation.
- Safe output:
  - [see remaining: tail -n +41 artifact://id]
- Why safe: no context loss; makes recovery cheaper.

P1 — high value, broader scope

6.  git stash: subcommand-aware compression

- Safe output:
  - ok stashed
  - No local changes to save
  - ok stash pop
  - list: stash@{0}: abc1234 message
- Keep stash show -p as current passthrough or compact diff later.

7.  git branch: group current/local/remote-only

- Safe output:
  - - main
  - local: feat/a, fix/b
  - remote-only (3): origin/x, upstream/y
- Risk: branch formats vary; fallback when nonstandard.

8.  git fetch: count ref updates

- Safe output:
  - ok fetched, 3 updates
  - ok fetched (up-to-date)
- Keep remote warnings/errors.

9.  git log: preserve useful body lines, strip trailers

- Keep up to 2–3 body lines.
- Strip Signed-off-by, Co-authored-by, etc.
- Useful for BREAKING CHANGE, issue refs, design notes.

10. AWS JSON extraction

- Gap: OMP cloud filter mostly head/tails JSON.
- Safe outputs:
  - EC2: i-abc t3.medium running 10.0.1.5 web
  - logs: timestamp level message
  - DynamoDB: unwrap typed values.
- Start with EC2 + CloudWatch logs.

11. kubectl -o json extraction

- Safe outputs:
  - pods: name ready status restarts age
  - services: name type clusterIP ports
- Preserve errors verbatim.

P2 — useful cleanup

12. npm/pnpm install noise expansion

- Strip more non-actionable lines:
  - up to date
  - audited
  - found 0 vulnerabilities
  - npm notice
  - progress/spinner frames
- Keep vulnerability/deprecation/script errors.

13. cargo install

- rtk strips dependency compile spam, keeps Installed/Replaced/Ignored/errors.
- OMP currently generic-compacts install.
- Safe output:
  - cargo install: ripgrep 14.1.1 installed
  - errors preserved.

14. cargo clippy

- Group warnings by lint rule.
- Safe output:
  - clippy::needless_return (12): src/a.rs:4, src/b.rs:9
- Keep actual errors full.

15. Global truncation caps

- Add named cap classes:
  - errors
  - warnings
  - list
  - inventory
- Use rtk-style reduced(cap, by) to avoid underflow/empty outputs.
- Lets us tune all filters coherently.

16. Normalized log dedup

- Normalize timestamps/UUIDs/hex/paths before dedup.
- Safe output:
  - <timestamp> ERROR connection refused (×47)
- Risk: over-normalizing numbers; test carefully.

Already good / recently done

- git push → now rtk-style ok <ref> / failure diagnostics.
- git commit → now rtk-style ok <hash> / ok (nothing to commit).
- pytest, uv run pytest → compact pytest: <counts>.
- npm/pnpm/yarn test, bun run test → routes to node test compression.
- cargo test success/failure summaries.
- git diff compaction solid.
- Raw output artifact recovery already better fit than rtk tee files.

Avoid porting

- rtk hook/proxy command rewrite layer. OMP shell capture is better place.
- rtk SQLite telemetry DB / outbound telemetry.
- rtk command lexer. OMP brush-parser is stronger.
- Blindly porting all TOML filters. Gaps are mostly structured Rust filters, not more regex.

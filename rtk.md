Best safe OMP improvements from rtk review.
Last updated: 2026-05-25 (v0.42.0 comparison, ~130 RTK commands vs 87+ OMP programs).

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
- Already implemented in listing.rs `center_truncate_match`.
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
- Already implemented in bash-executor.ts `buildArtifactRecoveryHint`.
- Safe output:
  - [see remaining: read artifact://id:<line>]
- Why safe: no context loss; makes recovery cheaper.

-----

New P0 — commonly used commands with NO OMP filter (fall to generic ANSI-strip+dedup+head/tail)

6.  make

- Gap: OMP has no make filter → generic fallback. Extremely common in C/C++, embedded, Go.
- Safe output: strip Entering/Leaving directory noise, keep targets + errors.
- Why safe: make output is well-structured; TOML-level regex filter sufficient.

7.  gcc / clang

- Gap: OMP has no C/C++ compiler filter → generic. Every C/C++ project.
- Safe output: strip compile progress, keep errors/warnings with file:line, summary.
- Why safe: compiler diagnostic format is standard across gcc/clang.

8.  terraform plan / tofu plan

- Gap: OMP has no IaC filter → generic. Universal in infra teams.
- Safe output: strip plan preamble, keep resource changes (create/update/destroy counts), errors.
- Why safe: plan output has consistent section markers.

-----

P1 — high value, broader scope (existing)

9.  git stash: subcommand-aware compression

- Safe output:
  - ok stashed
  - No local changes to save
  - ok stash pop
  - list: stash@{0}: abc1234 message
- Keep stash show -p as current passthrough or compact diff later.

10. git branch: group current/local/remote-only

- Safe output:
  - * main
  - local: feat/a, fix/b
  - remote-only (3): origin/x, upstream/y
- Risk: branch formats vary; fallback when nonstandard.

11. git fetch: count ref updates

- Safe output:
  - ok fetched, 3 updates
  - ok fetched (up-to-date)
- Keep remote warnings/errors.

12. git log: preserve useful body lines, strip trailers

- Keep up to 2–3 body lines.
- Strip Signed-off-by, Co-authored-by, etc.
- Useful for BREAKING CHANGE, issue refs, design notes.

13. AWS JSON extraction — expand coverage

- Gap: OMP cloud.rs handles 3 AWS subcommands (EC2, CloudWatch, DynamoDB).
  RTK handles 25+ (sts, s3, ec2, ecs, rds, cloudformation, logs, lambda, iam, dynamodb, eks, sqs, secretsmanager).
- Safe outputs:
  - sts: account/user ARN one-liner
  - s3: bucket name + creation date table
  - lambda: name/runtime/memory table (strip policy/role JSON)
  - iam: role/user name table (strip policy documents)
  - logs: timestamp level message
- Start with sts, s3, lambda, iam — highest frequency.

14. kubectl -o json extraction

- Already implemented in docker.rs (compact_kubectl_pods, compact_kubectl_services).
- Safe outputs:
  - pods: name ready status restarts age
  - services: name type clusterIP ports
- Preserve errors verbatim.

-----

New P1 — commands with WEAK OMP filter (recognized but treatment is minimal)

15. err — error extraction from any command

- Gap: OMP system.rs `err` = passthrough (only ANSI strip). Defeats the point.
- RTK: `rtk err <cmd>` extracts errors only from piped output.
- Safe output: keep only lines containing error/warning/failure/panic/diagnostic signals.
- Why safe: additive filter on already-captured output; no data loss (artifact persists).
- High leverage: works on ANY command, not just known programs.

16. aws — expand subcommand coverage

- Gap: Moved up to P1 item 13.

17. diff (standalone) — condensed diff

- Gap: OMP system.rs `diff` = passthrough. No standalone file diff compaction.
- RTK: `rtk diff` ultra-condensed unified diff.
- Safe output: compact diff via existing condense_diff in git.rs.
- Why safe: same algorithm already running for git diff; just wire the dispatcher.

18. test (generic) — failures-only wrapper

- Gap: OMP system.rs `test` = compact_test_output (strips non-essential, not failures-only).
- RTK: `rtk test <cmd>` extracts failures-only (-90%).
- Safe output: keep only FAIL/ERROR lines + summary counts.
- Why safe: original output in artifact; test failures are the signal.

19. systemctl status

- Gap: OMP has no filter → generic. Common in operations/sysadmin.
- Safe output: Active/loaded state + last log lines; strip unit path boilerplate.
- Why safe: systemctl status output is highly structured.

20. glab (GitLab CLI)

- Gap: OMP gh.rs handles GitHub CLI; glab falls to generic. All GitLab users.
- RTK: full glab_cmd.rs (mr, issue, ci, pipeline, api, release).
- Safe output: same strategies as gh.rs (markdown noise strip, table compaction).
- Why safe: glab JSON output mirrors gh; same extraction patterns work.

-----

P2 — useful cleanup (existing)

21. npm/pnpm install noise expansion

- Strip more non-actionable lines:
  - up to date
  - audited
  - found 0 vulnerabilities
  - npm notice
  - progress/spinner frames
- Keep vulnerability/deprecation/script errors.

22. cargo install

- rtk strips dependency compile spam, keeps Installed/Replaced/Ignored/errors.
- Already implemented in cargo.rs `filter_install`.
- Safe output:
  - cargo install: ripgrep 14.1.1 installed
  - errors preserved.

23. cargo clippy

- Group warnings by lint rule.
- Already implemented in cargo.rs `filter_clippy`.
- Safe output:
  - clippy::needless_return (12): src/a.rs:4, src/b.rs:9
- Keep actual errors full.

24. Global truncation caps

- Add named cap classes:
  - errors
  - warnings
  - list
  - inventory
- Use rtk-style reduced(cap, by) to avoid underflow/empty outputs.
- Lets us tune all filters coherently.

25. Normalized log dedup

- Normalize timestamps/UUIDs/hex/paths before dedup.
- Safe output:
  - <timestamp> ERROR connection refused (×47)
- Risk: over-normalizing numbers; test carefully.

-----

New P2 — remaining programs with NO OMP filter

26. gradle / gradlew / mvn (Java/Kotlin/Android build)

- Gap: OMP has no filter → generic. All Java/Kotlin/Android projects.
- RTK: gradlew_cmd.rs (Rust module) + mvn-build.toml + gradle.toml.
- Safe output: strip download/compile noise, keep task results + errors.
- Priority lower than make/gcc: fewer OMP users in Java ecosystem.

27. ansible-playbook / gcloud / pre-commit / rsync

- Gap: OMP has no filter → generic. Each common in its domain.
- RTK: dedicated TOML filters for each.
- Safe outputs: strip progress/ok noise, keep changed/failed counts.
- Bundle as TOML pipeline additions; no Rust code needed.

28. swift build/test / xcodebuild

- Gap: OMP has no filter → generic. iOS/macOS development.
- RTK: swift-build.toml + xcodebuild.toml.
- Safe outputs: compiler error extraction + summary.

29. mix compile / mix format (Elixir)

- Gap: OMP has no filter → generic.
- RTK: mix-compile.toml + mix-format.toml.

30. nx / turbo (monorepo build)

- Gap: OMP has no filter → generic.
- RTK: nx.toml + turbo.toml.

31. ollama

- Gap: OMP has no filter → generic.
- RTK: ollama.toml.

-----

RTK conceptual features with no OMP equivalent (investigate, not port blindly)

32. rtk read --level aggressive (body-stripping)

- RTK: strips function/method bodies, keeps signatures only.
- OMP listing.rs: source outline extraction for cat/read, but no body-stripping levels.
- Note: OMP built-in Read tool bypasses the minimizer entirely.
  The minimizer `read` dispatch is for the shell builtin `read` command (rare).
  Adding RTK-style read filtering to listing.rs only affects cat/shell-read via bash
  — does NOT touch OMP's Read tool.
- Worth doing: compact_source_outline is already close; add a --level flag pathway.

33. rtk smart (heuristic code summary)

- RTK: 2-line LLM-based heuristic code summary.
- No OMP equivalent.
- Lower priority: OMP already has manifest summarization + source outline.

34. rtk proxy (track-only passthrough)

- RTK: counts tokens without filtering, for coverage measurement.
- OMP equivalent: minimizer-gain.ts already records passthrough commands.
  The "missed" analytics serve the same discovery purpose.

-----

Already good / recently done

- git push → rtk-style ok <ref> / failure diagnostics.
- git commit → rtk-style ok <hash> / ok (nothing to commit).
- pytest, uv run pytest → compact pytest: <counts>.
- npm/pnpm/yarn test, bun run test → routes to node test compression.
- cargo test success/failure summaries.
- cargo clippy grouping by lint rule.
- cargo install filtering.
- git diff compaction solid.
- kubectl -o json extraction (pods, services).
- grep/rg center truncation in listing.rs.
- Artifact tail-offset hints in bash-executor.ts.
- Raw output artifact recovery better fit than rtk tee files.

Avoid porting

- rtk hook/proxy command rewrite layer. OMP shell capture is better place.
- rtk SQLite telemetry DB / outbound telemetry.
- rtk command lexer. OMP brush-parser is stronger.
- Blindly porting all TOML filters. Gaps are mostly structured Rust filters, not more regex.
- rtk pipe with named presets. OMP system.rs pipe heuristic + artifact fallback is sufficient.
- rtk format universal dispatcher. OMP formatters are handled natively (prettier/prisma/ruff/etc).

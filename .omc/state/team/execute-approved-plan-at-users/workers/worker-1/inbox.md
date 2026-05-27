## REQUIRED: Task Lifecycle Commands
You MUST run these commands. Do NOT skip any step.

1. Claim your task:
   omc team api claim-task --input '{"team_name":"execute-approved-plan-at-users","task_id":"1","worker":"worker-1"}' --json
   Save the claim_token from the response.
2. Do the work described below.
3. On completion (use claim_token from step 1):
   omc team api transition-task-status --input '{"team_name":"execute-approved-plan-at-users","task_id":"1","from":"in_progress","to":"completed","claim_token":"<claim_token>","result":"Summary: <what changed>\\nVerification: <tests/checks run>\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session"}' --json
   The result field is required for completion evidence. For broad delegated tasks, include either "Subagent skip reason: <why no nested worker was needed/allowed>" or, only when explicitly allowed by the leader, "Subagent spawn evidence: <child task names/thread ids and integrated findings>".
4. On failure (use claim_token from step 1):
   omc team api transition-task-status --input '{"team_name":"execute-approved-plan-at-users","task_id":"1","from":"in_progress","to":"failed","claim_token":"<claim_token>"}' --json
5. ACK/progress replies are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.

## Task Assignment
Task ID: 1
Worker: worker-1
Subject: Worker 1: Execute approved plan at /Users/davidandrews/PycharmProjects/lex/.omc/

Execute approved plan at /Users/davidandrews/PycharmProjects/lex/.omc/plans/rtk-md-completion-2026-05-27.md (committed at HEAD on rtk-md-completion branch). Plan APPROVED via ralplan consensus.

WORKER 1 (codex) — W1 (AWS expansion) + W2 (clang). Touch ONLY:
- crates/pi-shell/src/minimizer/filters/cloud.rs: 11 new aws subcommand extractors (sts, s3, lambda, iam, logs, ecs, rds, cloudformation, eks, sqs, secretsmanager); compact_aws_generic JSON walker; SENSITIVE_AWS_KEYS const [Policy, PolicyDocument, AssumeRolePolicyDocument, Environment, SecretString, SecretBinary, Token, SessionToken, Credentials, Password, PrivateKey, KeyMaterial, PlaintextKeyMaterial, CiphertextBlob, ResponseMetadata]; leak-sentinel test.
- crates/pi-shell/src/minimizer/detect.rs: new skip_aws_global_options modeled on existing per-program skippers at lines 93/108/131/144/157/171, wired via first_non_global_arg at line 303. Flag table per plan Step 1.1 (value-taking: --profile --region --endpoint-url --cli-binary-format --output --cli-read-timeout --cli-connect-timeout --ca-bundle --color --query --cli-input-json --cli-input-yaml; boolean: --no-cli-pager --debug --no-verify-ssl --no-paginate --no-sign-request --cli-auto-prompt --no-cli-auto-prompt; optional-value: --generate-cli-skeleton; --flag=value form; -- terminator). Property fuzz test 100+ permutations.
- crates/pi-shell/src/minimizer/defs/gcc.toml: change match_command to ^(gcc|g\+\+|clang|clang\+\+)$; add 2 [[tests.gcc]] clang cases.
- crates/pi-shell/tests/minimizer_chain_flag_matrix.rs (NEW): aws+clang chain/flag/passthrough/output-purity tests per AC-C1..C4.
DO NOT TOUCH: filters/listing.rs filters/ai_smart.rs engine.rs Cargo.toml bash-executor.ts config.rs.

WORKER 2 (claude) — W3 (source outline aggressive) + W4 (rtk smart, feature-gated). Touch ONLY:
- crates/pi-shell/src/minimizer/config.rs: pub enum OutlineLevel { Default, Aggressive }; ai_smart_enabled: bool (default false); ai_smart_provider: String (default "deepseek").
- crates/pi-shell/src/minimizer/filters/listing.rs: branch on OutlineLevel in compact_source_outline; aggressive replaces function/method bodies with { ... } for ts/tsx/js/jsx/py/rs/go.
- packages/coding-agent/src/exec/bash-executor.ts: surface sourceOutlineLevel through buildMinimizerOptions.
- packages/coding-agent/src/* relevant settings types: ShellMinimizerSettings.sourceOutlineLevel: 'default'|'aggressive'.
- crates/pi-shell/Cargo.toml: [features] ai-smart = ["dep:reqwest"]; reqwest optional with rustls-tls/json/blocking.
- crates/pi-shell/src/minimizer/filters/ai_smart.rs (NEW): #[cfg(feature = "ai-smart")] with off-feature stub. maybe_summarize(ctx, captured) -> Option<String>. None if !ai_smart_enabled OR parent is Pipe/Compound OR captured > 8KB OR OMP_AI_SMART_API_KEY unset OR per-apply budget consumed. Else POST https://api.deepseek.com/v1/chat/completions model deepseek-v4-flash, system 'You are a 2-line summarizer for shell command output. Line 1: what happened. Line 2: most important number/path/error. Be terse.', 5s timeout, 200 max tokens, single retry on transient, passthrough on error.
- crates/pi-shell/src/minimizer/engine.rs: wire ai_smart from apply() post-step AFTER apply_identity returns. cfg(feature = "ai-smart")-gated. AC4.9 per-apply ≤1 AI call budget across chain segments via Cell<u8>/MinimizerCtx counter.
- crates/pi-shell/tests/minimizer_chain_flag_matrix.rs: add W3+W4 rows (chain, flag, passthrough, output-purity).
DO NOT TOUCH: filters/cloud.rs detect.rs aws skipper defs/gcc.toml.

PINNED (BOTH):
- deepseek-v4-flash exact; if unavailable STOP and RFC, no silent downgrade.
- W4 strictly behind Cargo feature ai-smart, default OFF, zero behavioral change when off.
- Verify before commit: rtk cargo test -p pi-shell --lib && rtk cargo test -p pi-shell --test minimizer_chain_flag_matrix; W4: rtk cargo test -p pi-shell --features ai-smart.
- TS: cd packages/coding-agent && bun test test/bash-executor.test.ts test/minimizer-gain.test.ts.
- Mailbox ACK required before touching file outside assigned set.

REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.
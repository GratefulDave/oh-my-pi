# Phase 3 QA Evidence — parity/upstream-15.5.9-tierA

Date: 2026-05-28

## bun install
- Exit: 0

## bun run check:ts (Biome)
- Exit: 1
- Errors: 9 (same as `main` baseline — pre-existing, all in `packages/hashline/src` unused imports)
- **Delta vs main: 0 new errors**

## Test results per package

| Package | Branch | Tests | Pass | Fail | Notes |
| ------- | ------ | ----- | ---- | ---- | ----- |
| pi-natives | parity | 46 | 46 | 0 | Clean |
| pi-ai | main | 1499 | 1155 | 7 | Baseline |
| pi-ai | parity | 1535 | 1191 | 7 | +36 new tests all pass; **same 7 baseline failures** |
| pi-coding-agent | main | 3932 | 3570 | 9 | Baseline |
| pi-coding-agent | parity | 3932 | 3570 | 9 | **Same 9 baseline failures, no delta** |
| typescript-edit-benchmark | parity | 14 | 14 | 0 | Clean |

## Conclusion

- **Zero regressions** introduced by Tier A 10-commit cherry-pick chain.
- 36 new pi-ai tests (Wafer provider, image downscale, status-precedence, stream healing) all pass.
- Pre-existing failures unchanged; they are fork-specific and unrelated to upstream parity.

## Open follow-ups (not blockers for Tier A merge)

1. Fix baseline Biome errors in `packages/hashline/src/{tokenizer,patcher}.ts` (unused imports).
2. Triage pre-existing test failures: `ast_dump`, multi-path `find`, AgentSession OpenRouter routing, Codex Abort, OpenAI watchdog, etc.
3. Tier B work tracked in `.omc/autopilot/cherry-tier-a-deferred.log`.

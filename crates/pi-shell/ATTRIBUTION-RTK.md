# RTK Attribution

This crate ports algorithm fragments from [rtk-ai/rtk](https://github.com/rtk-ai/rtk).

## Pinned upstream

- **Repository:** https://github.com/rtk-ai/rtk
- **Branch:** develop
- **Commit SHA:** `878af7de99e0ba71da2e8fd996f6b52a1836e06c`
- **Snapshot date:** 2026-05-28T07:00:11Z
- **License:** MIT (compatible with this workspace's MIT license)

Per-file headers include the SHA permalink so every ported region is
unambiguously traceable to the upstream source.

## Ported regions

| omp path | rtk source | functions ported | notes |
|---|---|---|---|
| `src/minimizer/filters/python.rs` | `src/cmds/python/pytest_cmd.rs` | `filter_pytest`, `pytest_success`, `is_pytest_summary_line`, `looks_like_pytest_summary_part`, `push_pytest_summary_line` | Pytest state machine: preserve failures, errors, and final summary; strip header framing, progress dots, verbose PASSED. Unknown-state lines fall through to passthrough (RTK's defensive default) so xdist `[gwN]` and custom-reporter output survive intact. |

## Posture

- Direct algorithm ports carry attribution headers per the template in
  `.omc/plans/minimizer-filter-remediation.md` §T0.4.
- Structural inspiration (e.g. listing.rs grep/find always-group
  behavior) re-implements ideas; not a direct port. Attribution lives at
  the plan + this file level.
- Future ports must update this file in the same PR; SHA pinning is
  per-revision, not per-PR.

## Permalink template

```
https://github.com/rtk-ai/rtk/blob/878af7de99e0ba71da2e8fd996f6b52a1836e06c/<path>
```

For the pytest port:
https://github.com/rtk-ai/rtk/blob/878af7de99e0ba71da2e8fd996f6b52a1836e06c/src/cmds/python/pytest_cmd.rs

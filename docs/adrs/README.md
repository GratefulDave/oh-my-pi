# Fork ADRs

This directory records architectural decisions that are specific to this fork. The ADRs are short, implementation-oriented notes for behavior that intentionally diverges from upstream OMP behavior.

## Records

- [`foreign-config-compatibility-policy.md`](foreign-config-compatibility-policy.md): foreign Claude, Codex, Gemini, and Claude marketplace plugin config sources are disabled by default, with an opt-in compatibility setting.
- [`external-agent-orchestration.md`](external-agent-orchestration.md): `/orchestrate` and `/delegate` spawn real external agent processes through `acpx`, `tmux`, or `cmux` instead of only using in-process model APIs.

These ADRs document fork-specific divergence from upstream OMP behavior. They should describe behavior that exists in the fork today, not planned behavior.

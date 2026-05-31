---
name: github-tool-issue
description: Opens actionable GitHub issues in this fork for tool/harness bugs instead of leaving them only in ephemeral QA reports. Use when a tool behaves unexpectedly, the user says reports go nowhere, asks to file/open an issue, or mentions tool bugs in this repo/fork.
---

# GitHub Tool Issue

Use this skill when a tool or harness behavior needs durable fork-owned tracking in `GratefulDave/oh-my-pi`.

## Contract

- System-required `report_tool_issue` calls still happen when required by session policy.
- Do not stop there when the issue affects this fork. Open a GitHub issue too.
- Use the user's existing GitHub auth via `gh`; never ask for tokens or print secrets.
- Keep the issue actionable: exact tool, observed behavior, expected behavior, repro input if safe, repo/session context, and impact.
- Do not paste private file contents, secrets, full transcripts, or credentials.

## Quick start

1. Confirm the repo target:
   - Default: `GratefulDave/oh-my-pi`.
   - If `git remote get-url origin` points elsewhere, prefer the current fork unless user specified another repo.
2. Check for an existing issue before creating a duplicate:
   - `gh issue list --repo GratefulDave/oh-my-pi --search "<tool or error phrase> in:title,body" --state open`
3. Create an issue when no matching open issue exists:
   - `gh issue create --repo GratefulDave/oh-my-pi --title "<concise title>" --body-file <temp-body-file>`

## Body template

```md
## Summary
<one sentence: tool did X wrong>

## Tool
- Tool: `<tool name>`
- Surface: `<coding-agent|harness|TUI|extension|unknown>`

## Observed
<exact observed behavior/error, redacted if needed>

## Expected
<what should have happened>

## Repro
1. <minimal safe steps>
2. <include tool args or command shape, not secrets>

## Impact
<why this matters: lost edits, confusing UI, false success, no durable tracking, etc.>

## Notes
- Source repo: `GratefulDave/oh-my-pi`
- Local paths/transcripts omitted unless needed and safe.
```

## Title examples

- `edit tool reports delimiter repair on complete function replacement`
- `observer cards do not reflect async job completion`
- `extension loader drops pi-subagents backend without actionable error`

## If GitHub issue creation is blocked

If `gh` is unavailable, unauthenticated, or the fork has Issues disabled:

1. Save the issue body under `.omp/github-issues-pending/<slug>.md`.
2. Report the exact blocker and pending file path.
3. Ask for the missing repo setting or alternate issue target.

```text
[blocked] Could not open GitHub issue because <exact blocker>. Pending issue saved at `.omp/github-issues-pending/<slug>.md`.
```

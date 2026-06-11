---
name: babysit-pr
description: Monitor and manage open pull requests on can1357/oh-my-pi — CI status, review feedback, mergeability, and fixup commits. Use when user says "babysit PR #N", "check PRs", "what's blocking PR #N", or after pushing commits to an open PR.
---

# Babysit PR

Owns the lifecycle of open pull requests on `can1357/oh-my-pi`. Detects the user's open PRs (author: GratefulDave), fetches CI/review/merge state, and drives resolution.

## Detect PRs

When no PR number is specified, fetch all open PRs by author:

```
gh pr list --repo can1357/oh-my-pi --author GratefulDave --state open \
  --json number,title,headRefName,mergeable,reviews,statusCheckRollup,isDraft
```

When a PR number is given, fetch that specific PR:

```
gh pr view <N> --repo can1357/oh-my-pi \
  --json number,title,headRefName,body,baseRefName,mergeable,reviews,statusCheckRollup,commits,files,additions,deletions,isDraft
```

## Assess State

For each PR, collect:

- **Merge conflict**: `mergeable` field — `MERGEABLE` / `CONFLICTING` / `UNKNOWN`
- **CI status**: `statusCheckRollup` — look for `FAILURE` / `PENDING` / `SUCCESS`
- **Human reviews**: `reviews` — filter out `chatgpt-codex-connector`, look for blocking findings from `roboomp` or other collaborators. Each human review's `state`: `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` (COMMENTED with blocking content = needs action)
- **Commit SHA**: most recent commit `oid` — does it address all review feedback?
- **Draft status**: `isDraft` — draft PRs need marking ready

## Identify Blocker

Produce a short per-PR blocker summary:

| Symptom | Action |
|---------|--------|
| CI failure | Open CI logs, identify failing check, list failures |
| Merge conflict | `git fetch upstream main && git rebase upstream/main` on the fork branch |
| Pending human review | List unresolved review comments verbatim |
| Draft | Ask if ready to mark ready |
| stale review (commit pushed after review) | Re-request review from reviewer |

## Resolution Flow

### CI failure
1. `gh run view --repo can1357/oh-my-pi <run_id>` for failing check logs
2. Summarize failure reason, do NOT fix blindly — report to user

### Merge conflict
1. MUST ask user before rebasing a PR branch — PR branches on this fork may have unpushed local work
2. If user confirms: `gh pr merge <N> --rebase --repo can1357/oh-my-pi` is incorrect — use local workflow:
   ```
   git fetch upstream main
   git checkout pr/<name>
   git rebase upstream/main
   git push --force-with-lease origin pr/<name>
   ```

### Review feedback addressed
1. Verify latest commit SHA matches the feedback resolution
2. Re-request review: `gh pr edit <N> --add-reviewer <reviewer>`
3. Or just note to user that feedback is resolved and reviewer hasn't re-reviewed

### Stale / stalled
- Check `updatedAt` — if PR hasn't been touched in days, flag for user attention

## Output Format

```
## PR #<N>: <title>
- State: <open|merged|closed> (<draft if draft>)
- Branch: <headRefName> → <baseRefName>
- Mergeable: <yes|conflict|unknown>
- CI: <pass|fail|pending> — <N> failing checks: <name1>, <name2>
- Reviews: <N> human, <N> automated
- Blockers: <summary of what needs to happen>
```

## Verification

After pushing fixup commits to a branch, re-assess the same PR and report the delta (what changed).

## Constraints

- NEVER merge a PR without asking the user.
- NEVER rebase a PR branch without asking — PR branches may have unpushed local changes.
- NEVER push code changes without user direction — only report state.
- Run `gh` commands against `can1357/oh-my-pi`, not against this fork repo.

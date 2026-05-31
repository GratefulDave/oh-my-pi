# edit tool reports delimiter repair on complete function replacement

## Summary
`edit` reported delimiter-balance auto-repair and dropped duplicated trailing payload during a complete function replacement.

## Tool
- Tool: `edit`
- Surface: coding-agent harness tool

## Observed
`edit` returned/reportable behavior: "Edit again reported delimiter-balance auto-repair and dropped duplicated trailing payload for a complete function replacement."

## Expected
A complete function replacement should apply deterministically without delimiter-balance auto-repair or payload dropping unless the patch input is malformed. If repair is needed, the tool should expose enough diagnostics to identify the malformed region.

## Repro
Need capture next occurrence with the exact edit patch payload, target file, and resulting diagnostic. Do not include secrets or private file contents beyond the minimal affected hunk.

## Impact
Tool QA report is ephemeral for this fork; durable tracking is needed in `GratefulDave/oh-my-pi` once GitHub Issues is enabled or another issue target is provided.

## GitHub status
`gh issue list --repo GratefulDave/oh-my-pi ...` returned: repository has disabled issues.

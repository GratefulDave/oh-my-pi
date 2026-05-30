# Antigravity Adapter for OMP

This OMP extension registers `opencode-antigravity/*` models and routes them through the installed `opencode-antigravity-auth` OpenCode plugin.

The adapter reuses the OpenCode plugin's OAuth flow, account pool, request rewrite, quota scheduling, token refresh, and response transform. It does not port those internals into OMP.

## Configuration

The upstream plugin still owns its files:

- Runtime config: `~/.config/opencode/antigravity.json`
- Account pool: `~/.config/opencode/antigravity-accounts.json`

Log in from OMP with:

```sh
omp login opencode-antigravity
```

Then select models with:

```sh
omp --model opencode-antigravity/antigravity-claude-sonnet-4-6
omp --model opencode-antigravity/antigravity-gemini-3.1-pro
```

## Risk

The upstream project warns that this auth path may violate Google terms of service and that users have reported bans or shadow-bans. This wrapper cannot remove that risk. It only reduces OMP-specific divergence by sending OMP requests through the same upstream OpenCode plugin path.

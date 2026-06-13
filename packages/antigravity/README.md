# Antigravity for OMP/Lex

This OMP extension registers `antigravity/*` models and keeps Antigravity OAuth/request handling self-contained inside OMP/Lex.

It does not read OpenCode plugin config or account files, does not depend on the previous OpenCode auth package, and does not call OMP's native `google-antigravity` provider path.

## Configuration

Log in from OMP with:

```sh
omp login antigravity
```

Then select models with bare Antigravity model ids:

```sh
omp --model antigravity/claude-sonnet-4-6
omp --model antigravity/gemini-pro-agent
```

## Compatibility smoke

Use these exact commands after installing or rebuilding the extension:

```sh
omp login antigravity
omp --model antigravity/claude-sonnet-4-6 "Say hello"
```

## Backup

The previous OpenCode-plugin bridge is retained disabled under `packages/antigravity/_backups/opencode-antigravity-auth-bridge/`. OMP/Lex does not load it unless it is copied out manually.

## Risk

The parity source warns that this auth path may violate Google terms of service and that users have reported bans or shadow-bans. This extension cannot remove that risk. It only avoids mixing OpenCode plugin storage and OMP's native `google-antigravity` request path into the active `antigravity` provider.

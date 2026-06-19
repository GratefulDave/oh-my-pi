# Antigravity extension for OMP

This package registers provider id `ag` and now mirrors the old `opencode-antigravity-auth` request path instead of issuing a separate hand-rolled Cloud Code Assist transport.

The goal is call parity with the old adapter while keeping the provider id and profile/model selectors under `ag/...`.

## Configuration

Load the built bundle from OMP settings:

```json
{
  "extensions": ["packages/ag/dist/ag.bundle.js"]
}
```

Use one of these entrypoints:

```sh
# Inside the interactive TUI
/login ag

# Direct CLI path
omp auth-broker login ag
```

In the interactive picker, choose **Antigravity**. You are logging into the shared Antigravity provider once; **Gemini 3**, **Claude**, and **GPT-OSS** are model choices you pick later under `ag/...`, not separate login providers.

Then select models with:

```sh
omp --model ag/claude-sonnet-4-6
omp --model ag/gemini-3.5-flash:low
```

Canonical AG selectors now mirror the old adapter contract:

```text
ag/gemini-3.5-flash:low|medium|high
ag/gemini-3.1-pro:low|high
ag/claude-sonnet-4-6
ag/claude-opus-4-6-thinking:low|medium|high
ag/gpt-oss-120b
ag/gpt-oss-20b
```

Legacy Gemini selector aliases such as `ag/gemini-3.5-flash-low` and `ag/gemini-pro-agent` are normalized for compatibility, but the canonical selectors above are the ones to use going forward.

## Development smoke

```sh
bun --cwd=packages/ag run build
omp
# then run: /login ag
```

## Risk

This auth path still uses the same Antigravity / Cloud Code Assist surface that may violate Google terms of service. This package only removes the OpenCode bridge dependency; it does not remove account risk.

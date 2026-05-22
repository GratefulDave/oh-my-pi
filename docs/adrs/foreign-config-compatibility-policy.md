# Foreign Config Compatibility Policy

## Decision

This fork disables foreign config sources by default.

Foreign sources are:

- `.claude`
- `.codex`
- `.gemini`
- Claude marketplace plugin roots

Native `.omp` config remains the default behavior. Foreign config can be loaded by opting in with `compatibility.loadForeignConfig`.

## Context

This fork should prefer native `.omp` behavior. Loading upstream Claude, Codex, Gemini, or Claude marketplace assets by default can accidentally import workflows, commands, agents, or plugins that were written for another runtime.

The default is therefore conservative: do not pick up foreign config unless the user asks for compatibility behavior.

## Implementation

Implementation files:

- [`packages/coding-agent/src/capability/index.ts`](../../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/task/discovery.ts`](../../packages/coding-agent/src/task/discovery.ts)
- [`packages/coding-agent/src/extensibility/custom-commands/loader.ts`](../../packages/coding-agent/src/extensibility/custom-commands/loader.ts)
- [`packages/coding-agent/src/modes/components/agent-dashboard.ts`](../../packages/coding-agent/src/modes/components/agent-dashboard.ts)
- [`packages/coding-agent/src/config/settings-schema.ts`](../../packages/coding-agent/src/config/settings-schema.ts)

`settings-schema.ts` defines `compatibility.loadForeignConfig` as a boolean setting with default `false`.

`capability/index.ts` treats these provider IDs as foreign:

- `claude`
- `claude-plugins`
- `codex`
- `gemini`

When `compatibility.loadForeignConfig` is false, those providers are implicitly disabled before capability loading. This affects provider-backed discovery such as slash commands and other registered capability providers.

Some paths discover files directly instead of only going through capability providers. Those paths apply the same provider-enabled check:

- `task/discovery.ts` filters `.claude`, `.codex`, and `.gemini` agent directories through `isProviderEnabled(...)`.
- `task/discovery.ts` only scans Claude marketplace plugin `agents/` directories when `claude-plugins` is enabled.
- `custom-commands/loader.ts` filters `.claude`, `.codex`, and `.gemini` command directories before loading TypeScript custom commands.
- `agent-dashboard.ts` filters candidate agent creation directories so new agents are written only to enabled config sources.

## Opting back in

Set `compatibility.loadForeignConfig` to `true` to restore foreign config loading. With the setting enabled, provider filtering no longer implicitly disables `claude`, `claude-plugins`, `codex`, or `gemini`; direct discovery paths for `.claude`, `.codex`, `.gemini`, and Claude plugin agent roots can participate again.

Explicitly disabled providers still remain disabled through the normal `disabledProviders` setting.

## Consequences

- Fresh fork installs do not accidentally import upstream Claude/Codex/Gemini workflows or Claude marketplace assets.
- Users who intentionally share config across tools must opt in.
- Documentation and support should treat `.omp` as the native source of truth for this fork.
- Compatibility mode is coarse-grained today: enabling it permits all supported foreign provider families rather than selecting one foreign source at a time.

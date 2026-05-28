# ADR: Library Provider

**Status**: Accepted  
**Date**: 2026-05-27

## Context

The user maintains a `the-library` hub (`~/PycharmProjects/the-library/`) that catalogs skills,
MCPs, rules, hooks, and slash commands with a `library.yaml` (schema v4). OMP previously
discovered hub skills only via `skills.customDirectories` pointing at a profile subfolder —
no provider attribution, no `enabled_for` flag filtering, no per-repo override.

## Decision

Add a first-class `library` provider (priority 90, between `native`/100 and `claude`/80).

### What it scans

1. Reads `$LIBRARY_HUB/library.yaml` (hub path from `$LIBRARY_HUB` env, then
   `~/.config/library/path` file, then skipped with a debug log).
2. Filters `skills.*` entries where `enabled_for[]` contains `"omp"` (case-sensitive).
3. Loads `SKILL.md` from `{hub}/{local_path}/SKILL.md` for each passing entry.
4. Returns `Skill` objects with `provider = "library"` source metadata.

### Per-repo override

If `<cwd>/.library.yaml` exists, it may specify:
- `skills: [names]` — intersect with global enabled set
- `extra_skills: [names]` — add on top (project level)
- `disable_skills: [names]` — remove from final set

### Settings

| Key | Default | Effect |
|-----|---------|--------|
| `skills.enableLibraryUser` | `true` | Toggle global hub skills |
| `skills.enableLibraryProject` | `true` | Toggle per-repo `.library.yaml` overrides |

### Foreign provider handling

`library` is NOT in `FOREIGN_PROVIDER_IDS` (no change to `capability/index.ts` needed).
It loads unconditionally like `native` and `agents`.

## How it differs from other providers

| Provider | Source | Priority | Key Filter |
|----------|--------|----------|------------|
| `native` | `~/.omp/` + `.omp/` | 100 | `enabled !== false` in frontmatter |
| **`library`** | **`$LIBRARY_HUB/library.yaml`** | **90** | **`enabled_for: [omp]`** |
| `claude` | `~/.claude/` + `.claude/` | 80 | `enabled !== false` in frontmatter |
| `agents` | `~/.agent[s]/` + `.agent[s]/` | 70 | `enabled !== false` in frontmatter |

## Out of scope (deferred)

Loading hooks, MCPs, rules, and slash commands from `library.yaml` is deferred.
The provider currently loads skills only. A `TODO` comment in `library.ts` marks the
extension point. These would follow the same `enabled_for: [omp]` filtering pattern.

## Consequences

- Hub skills with `enabled_for: [omp]` appear in OMP with `Library` attribution in the provider list.
- `skills.customDirectories` pointing to a hub profile folder remains supported in parallel.
- Per-repo repos can pin or restrict hub skills via `.library.yaml` without touching the hub.

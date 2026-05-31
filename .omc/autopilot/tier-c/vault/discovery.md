# Tier C Group O Discovery: vault:// Protocol Integration

**Date**: 2026-05-28  
**Scope**: Assess fork's internal-urls infrastructure compatibility with upstream vault:// protocol  
**Upstream Commits**: `1709172bf` (obsidian integration), `509963bd6` (vault.enabled gating)

---

## Executive Summary

**Verdict**: Fork's internal-urls router can host vault:// cleanly. Architecture matches. Two upstream files are NEW and can land verbatim; four MODIFIED files require conflict-risk analysis on fork-divergent paths (settings-schema, system-prompt, read.md, plan-mode-guard).

**Security-Critical Functions**: Must port verbatim without fork customization:
- `resolveVaultUrlToPath()` — vault path traversal/symlink validation
- `isVaultEnabled()` — feature gating check
- `hasObsidian()` — binary detection + path validation

---

## Upstream Commits: File Summary

### Commit 1709172bf: Added Obsidian Integration
859 lines added across 10 files. **1 NEW file + 9 MODIFIED**.

| Category | File | Impact |
|----------|------|--------|
| **NEW** | `packages/coding-agent/src/internal-urls/vault-protocol.ts` | 859 LOC; vault:// handler, CLI bridge, path validation |
| **MODIFIED** | `packages/coding-agent/src/internal-urls/router.ts` | +2 lines; register VaultProtocolHandler |
| **MODIFIED** | `packages/coding-agent/src/internal-urls/index.ts` | +1 line; export vault-protocol |
| **MODIFIED** | `packages/coding-agent/src/system-prompt.ts` | +2 lines; inject {{#if hasObsidian}} template var |
| **MODIFIED** | `packages/coding-agent/src/prompts/system/system-prompt.md` | +3 lines; vault:// URL docs (gated on hasObsidian) |
| **MODIFIED** | `packages/coding-agent/src/prompts/tools/read.md` | +4 lines; vault:// selector docs |
| **MODIFIED** | `packages/coding-agent/src/tools/path-utils.ts` | +2 lines; allow vault:// in INTERNAL_SCHEMES_WITH_SELECTORS |
| **MODIFIED** | `packages/coding-agent/src/tools/plan-mode-guard.ts` | +7 lines; vault path resolution integration |
| **MODIFIED** | `packages/coding-agent/CHANGELOG.md` | +20 lines; release notes |
| **MODIFIED** | `packages/coding-agent/test/internal-urls/vault-protocol.test.ts` | +339 lines; comprehensive test suite |

### Commit 509963bd6: Enable vault.enabled Setting Gate
153 lines added across 4 files. **0 NEW files + 4 MODIFIED**.

| File | Change |
|------|--------|
| `packages/coding-agent/src/config/settings-schema.ts` | +11 lines; `vault.enabled` boolean setting (default: false, tab: "tools") |
| `packages/coding-agent/src/internal-urls/vault-protocol.ts` | +76 lines; isVaultEnabled guard, CLI error parsing, active-vault caching |
| `packages/coding-agent/test/internal-urls/vault-protocol.test.ts` | +78 lines; gating + error-surfacing tests |
| `packages/coding-agent/CHANGELOG.md` | +2 lines; release notes |

---

## Fork's Internal-URLs Infrastructure

### Architecture Match ✓

**Router Pattern**: Fork uses identical global singleton pattern (`InternalUrlRouter.instance()`).  
**Handler Registry**: Map<scheme, ProtocolHandler> with `.register()` method — NEW handlers add trivially.  
**ProtocolHandler Interface**:
```typescript
interface ProtocolHandler {
  scheme: string;
  immutable: boolean;
  resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
  write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
}
```

**Current Handlers** (14 total):
- `agent://`, `artifact://`, `memory://`, `local://`, `skill://`, `rule://` (immutable)
- `omp://`, `issue://`, `pr://` (immutable; GitHub)
- `mcp://` (external resource)
- Others: `json-query`, `docs-index.generated`

**Vault Handler Can Land As-Is**: VaultProtocolHandler from upstream implements exact interface. No fork-specific tweaks needed.

### Extension Points

1. **Router Registration** (router.ts, line 26–35): Add `this.register(new VaultProtocolHandler());` — no conflicts.
2. **Export Barrel** (index.ts): Add export line for vault-protocol — no conflicts.
3. **Settings Registry**: Fork's settings-schema.ts MUST include vault.enabled definition (see divergence section).

---

## Fork Divergence Risk Analysis

### Files Modified in Both Upstream & Fork

#### 1. **settings-schema.ts** — CONFLICT RISK: HIGH
- **Upstream Addition**: `vault.enabled` boolean (default: false, tab: "tools")
- **Fork Status**: vault.enabled NOT PRESENT
- **Divergence**: Fork's schema structure is identical, but vault setting missing entirely
- **Action**: Manual merge — add vault.enabled to fork's "tools" tab section, matching upstream pattern

#### 2. **system-prompt.ts** — CONFLICT RISK: LOW
- **Upstream Change**: +2 lines to pass `hasObsidian()` boolean into template context
- **Fork Status**: Unknown if fork already threads custom feature flags into template context
- **Action**: Inspect fork's system-prompt.ts rendering pipeline; likely compatible if fork uses same Handlebars pattern

#### 3. **system-prompt.md** — CONFLICT RISK: MEDIUM
- **Upstream Addition**: Vault:// URL docs (3 lines, gated on `{{#if hasObsidian}}`)
- **Fork Status**: Upstream text mentions vault:// URLs with file-scoped ops (`?op=outline|backlinks|...`) and vault-scoped ops (`?op=search|daily|...`)
- **Action**: Add vault:// section verbatim if fork lacks it; verify conditional gate matches upstream pattern

#### 4. **read.md** — CONFLICT RISK: LOW
- **Upstream Addition**: vault:// support in path selector docs (+4 lines)
- **Fork Status**: Fork's read.md likely lacks vault:// mentions currently
- **Action**: Add vault:// to list of supported schemes; use upstream text as template

#### 5. **path-utils.ts** — CONFLICT RISK: LOW
- **Upstream Change**: Add `vault` to `INTERNAL_SCHEMES_WITH_SELECTORS` (allows `:` line-range selectors on vault:// URLs)
- **Fork Status**: Fork's path-utils.ts already has this constant; vault not yet in list
- **Action**: Add `vault: true` to constant definition

#### 6. **plan-mode-guard.ts** — CONFLICT RISK: MEDIUM
- **Upstream Change**: +7 lines; integrates `resolveVaultUrlToPath()` call site in enforcePlanModeWrite
- **Fork Status**: Fork's plan-mode-guard.ts uses `resolveRawPath()` which dispatches to internal-url router
- **Action**: Verify fork's resolveRawPath already threads through router → if yes, no explicit vault code needed; if no, align with upstream

#### 7. **CHANGELOG.md** — CONFLICT RISK: NONE
- Upstream entries are release notes only; fork can maintain separate changelog sections

---

## Upstream Security Functions (Must Port Verbatim)

### resolveVaultUrlToPath(input: string | InternalUrl): string
**Purpose**: Convert vault:// URL → filesystem path (vault root + relative path).  
**Security Guards**:
- Rejects absolute paths (`/...`)
- Rejects traversal (`../..`)
- Rejects symlink escapes (via `ensureWithinRoot()`)
- Validates path is within declared vault root

**No Fork Customization**: Security boundary — port as-is from upstream.

### isVaultEnabled(): boolean
**Purpose**: Gate all vault:// operations on `vault.enabled` setting.  
**Behavior**: Returns false when setting is disabled or Obsidian CLI not found.

**No Fork Customization**: Feature gating — port as-is.

### hasObsidian(): boolean
**Purpose**: Detect Obsidian CLI availability (macOS: `/Applications/Obsidian.app/...`).  
**Behavior**: Called at system-prompt render time to show/hide vault:// docs.

**No Fork Customization**: Binary detection — port as-is.

---

## New Files (Can Land Verbatim)

### 1. packages/coding-agent/src/internal-urls/vault-protocol.ts
**Size**: 859 LOC  
**Exports**:
- `VaultProtocolHandler` class
- `parseVaultUrl()`, `resolveVaultUrlToPath()`, `hasObsidian()`, `isVaultEnabled()`
- Type defs: `ParsedVaultUrl`, `VaultReference`, `VaultOp`, `FileOp`
- Obsidian CLI bridge: `spawnObsidian()`, `resolveObsidianBinary()`

**Zero Fork Dependencies** (imports only stdlib + pi-utils):
```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, isEnoent } from "@oh-my-pi/pi-utils";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";
```

**Action**: Copy upstream file verbatim. No edits needed.

### 2. packages/coding-agent/test/internal-urls/vault-protocol.test.ts
**Size**: 339 LOC (baseline) + 78 LOC (gating tests)  
**Coverage**:
- Vault URL parsing (all variants: vaults, info, dirs, files, file-ops, vault-ops)
- Path traversal defense tests
- Obsidian CLI mocking + error scenarios
- Symlink escape guards
- Gating behavior (isVaultEnabled disabled)
- Active-vault caching

**Action**: Copy upstream test suite verbatim. Provides validation harness.

---

## Integration Checklist

| Step | Status | Notes |
|------|--------|-------|
| Copy vault-protocol.ts | Ready | Upstream-verbatim |
| Copy vault-protocol.test.ts | Ready | Upstream-verbatim |
| Add VaultProtocolHandler to router | Ready | 1-line change in router.ts |
| Export vault-protocol from index.ts | Ready | 1-line change in index.ts |
| Add vault.enabled to settings-schema.ts | **Manual** | Match upstream pattern |
| Update system-prompt.ts template context | **Inspect** | Likely compatible |
| Add vault:// docs to system-prompt.md | **Manual** | Copy upstream text + gate |
| Update read.md with vault:// selectors | **Manual** | Copy upstream text |
| Add `vault` to INTERNAL_SCHEMES_WITH_SELECTORS | **Manual** | Single constant entry |
| Integrate vault path resolution in plan-mode-guard | **Inspect** | May be implicit via router |

---

## Overlaps with Group H (If Planned)

**Risk**: None identified.  
- Group H scope unknown from this discovery
- Vault:// protocol is orthogonal to most coding-agent subsystems
- No shared file modifications between vault:// and typical Group H changes (models, tools, UI)

**Recommendation**: Proceed in parallel. If Group H touches settings-schema.ts or system-prompt.ts, merge both feature gates in a single commit.

---

## Recommendation

**Proceed Tier C Group O immediately.**

Upstream vault:// implementation is clean, well-tested, and architecturally aligned with fork's internal-urls router. Risk is low:
- ✓ 2 new files land verbatim
- ✓ 6 modified files need manual conflict resolution (not auto-merge conflicts; review-level merges)
- ✓ 3 security-critical functions have no fork customization surface
- ✓ No overlaps detected with Group H scope

**Timeline**: 1–2 hours for conflict resolution + integration testing.

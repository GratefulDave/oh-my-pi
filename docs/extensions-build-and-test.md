# Building and Testing OMP Extensions (Lex Fork)

How the LexGenius fork's enhancements live as **omp extensions** — TypeScript packages that
bundle to `dist/*.bundle.js` and register in `.omp/settings.json`, so they survive upstream
pulls of the `omp` binary without touching its source.

> Native/Rust changes (`crates/pi-shell`, `crates/pi-natives`, `crates/brush-core-vendored`)
> **cannot** be extensions. Those follow the fork+rebase path — see
> [`upstream-rebase-and-fork-maintenance.md`](./upstream-rebase-and-fork-maintenance.md).

---

## 1. The extension model

An extension is a bundled JS module loaded at runtime by the coding-agent. Three pieces:

1. **Source** — a TypeScript package (`packages/<name>/src/extension.ts` default export, or a
   single-file `.omp/extensions/<name>/index.ts`).
2. **Bundle** — Bun bundles the source to a single `dist/<name>.bundle.js`.
3. **Registration** — the bundle path is listed in `.omp/settings.json` `"extensions"`.

The loader (`packages/coding-agent/src/discovery/omp-extension-roots.ts`) reads the
`"extensions"` array and resolves each path relative to `cwd`. Precedence:
CLI `--extension` > project `<cwd>/.omp/settings.json` > user `~/.omp/agent/settings.json` >
installed plugins.

Because the binary loads extensions from settings + dist, **you can pull/replace the upstream
binary and the extensions keep working** — nothing in the binary's own source is forked.

---

## 2. Extension inventory

| Extension | Source dir | Entry | Bundle output | Build? |
|-----------|-----------|-------|---------------|--------|
| antigravity-adapter | `packages/antigravity-adapter/` | `src/extension.ts` | `dist/antigravity.bundle.js` | yes |
| pi-minimizer-gain | `packages/pi-minimizer-gain/` | `src/extension.ts` | `dist/gaing.bundle.js` | yes |
| pi-distill | `packages/pi-distill/` | `src/index.ts` | `dist/distill.bundle.js` | yes |
| pi-observer | `packages/pi-observer/` | `src/extension.ts` | `dist/observer.bundle.js` | yes |
| pi-actor-swarm | `packages/pi-actor-swarm/` | `src/extension.ts` | `dist/swarm.bundle.js` | yes |
| pi-omnidelegate | `packages/pi-omnidelegate/` | `src/extension.ts` | `dist/omnidelegate.bundle.js` | yes |
| pi-software-factory | `packages/pi-software-factory/` | `src/extension.ts` | `dist/factory.bundle.js` (+ CLI bins) | yes (`build-bin.ts`) |
| swarm-extension | `packages/swarm-extension/` | `src/extension.ts` | `dist/extension.bundle.js` | pre-built |
| profile-manager | `.omp/extensions/profile-manager/` | `index.ts` | `dist/index.js` | pre-built |
| semantic-search | `.omp/extensions/semantic-search/` | `index.ts` | source (unbundled) | none |

Currently registered in `.omp/settings.json`: all of the above **except** semantic-search
(load it via `--extension` or by adding its path).

---

## 3. Build

**Bundler:** Bun's `Bun.build()` API, driven by per-package `scripts/build-bundle.ts`.

### Build one extension
```bash
bun --cwd=packages/pi-observer run build
# -> packages/pi-observer/dist/observer.bundle.js
```

### Build all managed extensions
```bash
bun scripts/rebuild-extensions.ts
```
In the Lex fork this also rebuilds `packages/natives` before extension bundles. In an exported
personal-extension repo without `packages/natives`, the same script automatically skips the native
build and rebuilds only managed extension targets discovered from `.omp/settings.json` and package
manifests.
### Bundler config (canonical, from `pi-observer/scripts/build-bundle.ts`)
```ts
await Bun.build({
  entrypoints: [path.join(root, "src/extension.ts")],
  outdir:      path.join(root, "dist"),
  target:      "bun",
  format:      "esm",
  naming:      "observer.bundle.js",          // per-extension output name
  external:    ["@oh-my-pi/pi-coding-agent"],  // host-provided, never bundled
  plugins:     [stubPiNatives],                // @oh-my-pi/pi-natives -> JS stub
});
```

Key points when authoring a new extension's build script:
- `external: ["@oh-my-pi/pi-coding-agent"]` — the host injects this at runtime. Bundling it
  duplicates the SDK and breaks identity checks.
- The `stub-pi-natives` plugin replaces `@oh-my-pi/pi-natives` imports with a pure-JS stub so
  the bundle has **no native dependency**. If an extension genuinely needs native calls at
  runtime, it must reach them through the host SDK, not by importing the addon.
- `target: "bun"`, `format: "esm"`, `"type": "module"` in package.json.

---

## 4. Register

Edit `.omp/settings.json` (project scope):
```json
{
  "extensions": [
    "packages/pi-observer/dist/observer.bundle.js",
    ".omp/extensions/profile-manager/dist/index.js"
  ]
}
```
Paths are relative to the directory you launch omp from. Order is load order.

To test without editing settings, inject at launch:
```bash
omp --extension packages/pi-observer/dist/observer.bundle.js
```

### Install into user-scope stock `omp`/`lex`
```bash
bun scripts/install-user-extensions.ts
bun run extensions:smoke:stock
```
The installer symlinks built bundles into `~/.omp/agent/extensions/<name>/`, writes the tilde paths
to both `~/.omp/agent/settings.json` and `~/.omp/agent/config.yml`, and preserves unmanaged user
extensions. The smoke command verifies those symlinks/settings, then launches `omp --version`; pass
`--list-models` when you also want a runtime provider-load check.

### Export to a standalone personal extension repo
```bash
bun run extensions:export -- --dest ../omp-personal-extensions --force
```
The export copies managed extension packages, local `.omp/extensions/*` entries, installer/build
scripts, and `.omp/settings.json`; generated package manifests strip `-lex` dependency ranges back
to stock `@oh-my-pi/*` versions so the repo can install against stock `omp` packages. Keep that repo
private unless the Antigravity/provider behavior is intentionally public.

---

## 5. Test with omp

### A. Unit tests (fastest loop — direct source import, no bundle/binary)
```bash
bun --cwd=packages/pi-observer run test        # one extension
bun run test:ts                                # all TS tests (--only-failures)
```
Tests use `bun:test` and import the source directly, e.g.
`packages/pi-observer/test/subagent-aggregation.test.ts` imports `../src/extension` and
`../src/stats-collector`. This bypasses bundling — good for logic, does **not** prove the
bundle loads in a real binary.

### B. Integration — load the built bundle in a running omp

1. Build the bundle (§3).
2. Ensure it is registered (§4) **or** pass `--extension`.
3. Launch the agent against this repo as cwd:
   ```bash
   bun run dev        # = bun --cwd=packages/coding-agent src/cli.ts   (source omp)
   # or the installed fork binary:
   lex
   ```
4. Verify it actually loaded:
   - Extension-specific surface: pi-observer dashboard, profile-manager slash command, etc.
   - Registered commands/tools appear in the agent.
   - Check logs for load errors (a bad `external` or a real native import surfaces here).

### C. Lint / typecheck
```bash
bun --cwd=packages/pi-observer run check
```

### Watch loop (no built-in dev mode)
```bash
# crude rebuild-on-save:
while true; do bun --cwd=packages/pi-observer run build; sleep 1; done
```
Restart omp to pick up a new bundle (extensions load at startup).

---

## 6. Adding a new extension — checklist

1. `packages/<name>/` with `package.json` (`"type":"module"`, `"omp":{"extensions":["./dist/<name>.bundle.js"]}`), `tsconfig.json`, `src/extension.ts` (default export).
2. Copy `scripts/build-bundle.ts` from pi-observer; change `naming` to `<name>.bundle.js`.
3. `bun --cwd=packages/<name> run build` — confirm `dist/<name>.bundle.js` appears.
4. Add the dist path to `.omp/settings.json` `"extensions"`.
5. Add `test/*.test.ts` (`bun:test`, import from `../src`).
6. `bun --cwd=packages/<name> run test && bun --cwd=packages/<name> run check`.
7. Launch omp, confirm the extension loads and its surface works (§5B).

---

## 7. Off-lex status (does it need the fork binary?)

- **OFF-LEX SAFE** (run on stock upstream omp): pi-observer, pi-actor-swarm, pi-omnidelegate,
  pi-software-factory, swarm-extension, semantic-search, profile-manager (reprofiled to read/write
  `.omp/settings.json` `modelProfiles`, no LEX `getProfileApi`).
- **FRAGILE**: antigravity-adapter — uses internal `pi-ai` subpath imports; AG code is fork-only
  and must never enter upstream.
- **BLOCKED**: pi-minimizer-gain — depends on `pi-natives` native surface; unblocks when the NAPI
  minimizer binding (PR #1642) lands.

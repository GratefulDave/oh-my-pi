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

## 2. Extension policy

`profile-manager` is the only fork-managed extension; it provides `/pm`. Other fork-managed
extensions are disabled and removed. Herdr remains externally managed outside this repository.

---

## 3. Build

`profile-manager` is a single-file extension, built directly from its source:
```bash
bun build .omp/extensions/profile-manager/index.ts \
  --outfile .omp/extensions/profile-manager/dist/index.js \
  --target bun --format esm
```

Use the repository recipe instead:
```bash
just build-exts
```

The output is `.omp/extensions/profile-manager/dist/index.js`. No package-scoped extension build
targets remain in this fork.

---

## 4. Register

`.omp/settings.json` registers the built extension at project scope:
```json
{
  "extensions": [".omp/extensions/profile-manager/dist/index.js"]
}
```
Paths are relative to the directory you launch omp from.

---

## 5. Test with omp

1. Build the extension (§3).
2. Launch the agent from this repository:
   ```bash
   bun run dev        # source omp
   # or the installed fork binary:
   lex
   ```
3. Run `/pm` and verify profile-manager loads without an extension error.

The extension has no package-local unit-test or check target. Run the repository's focused
coding-agent tests when changing its host integration.

---

## 6. Extension policy

New fork-managed extension packages are not supported. Keep personal or experimental extensions
outside this repository; the rebuild workflow preserves their installed bundles without rebuilding
or registering them.

---

## 7. Stock-OMP compatibility

`profile-manager` uses `.omp/settings.json` `modelProfiles` and is safe to load on stock upstream
omp.


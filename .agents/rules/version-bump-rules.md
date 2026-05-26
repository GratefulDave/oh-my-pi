# Version Bump Rule

**Usage**: Required checklist for any repo/package version bump.

## Rule

Never bump only `package.json` files. A version bump is complete only when every lockstep version surface and generated native sentinel is updated and verified.

## Required Path

Prefer the release script:

```bash
bun scripts/release.ts <version>
```

If doing a manual fork/upstream sync, update and verify all of these together:

1. Root catalog `@oh-my-pi/*` entries in `package.json`.
2. Every public `packages/*/package.json` version.
3. Rust workspace version in `Cargo.toml`.
4. Lockfiles:
   - `bun.lock`
   - `Cargo.lock`
5. `pi-natives` version sentinel:
   - `crates/pi-natives/src/lib.rs`
   - `packages/natives/native/index.js`
   - `packages/natives/native/index.d.ts`
6. Native addon and compiled CLI when `packages/natives` or `packages/coding-agent` are affected:
   - `bun --cwd=packages/natives run build`
   - `bun --cwd=packages/coding-agent run build`

## Verification

Before declaring a version bump done, run:

```bash
bun install --frozen-lockfile
cargo metadata --locked --no-deps
bun test packages/natives/test/windows-staging.test.ts --test-name-pattern "pi-natives version sentinel"
bun --cwd=packages/natives run check
bun run ci:test:smoke
```

If a rebuilt compiled `omp` is used locally, also clear or rotate stale native cache before smoke testing:

```bash
mv ~/.omp/natives/<version> ~/.omp/natives/<version>.bad-$(date +%Y%m%d%H%M%S) 2>/dev/null || true
omp --smoke-test
```

## Why

The native loader derives its expected sentinel from `@oh-my-pi/pi-natives` package version. If package versions move but Rust/generated native exports do not, the compiled CLI can extract a stale `.node` and fail at launch with a missing `__piNativesV...` sentinel.

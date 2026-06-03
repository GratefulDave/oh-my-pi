import { mock } from "bun:test";

// `opencode-antigravity-auth/.../plugin/storage` (pulled in transitively by the
// quota/token value imports the adapter uses) does `import lockfile from "proper-lockfile"`.
// proper-lockfile's CJS `require("signal-exit")` expects signal-exit v3's default-function
// export, but the workspace hoists signal-exit@4 (named exports only), so its top-level
// `onExit(...)` call throws "onExit is not a function" at module load and crashes the
// whole test file before any test runs.
//
// The adapter never persists credentials through storage (its PluginClient.auth.set is a
// no-op), so file locking is dead weight. Mirror the production bundle's stub-proper-lockfile
// shim here so the source-level test imports load cleanly.
const lock = async () => async () => {};
const unlock = async () => {};
const check = async () => false;
mock.module("proper-lockfile", () => ({ lock, unlock, check, default: { lock, unlock, check } }));

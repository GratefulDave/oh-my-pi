import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");

const result = await Bun.build({
	entrypoints: [path.join(root, "src/extension.ts")],
	outdir: path.join(root, "dist"),
	target: "bun",
	format: "esm",
	naming: "extension.bundle.js",
	external: ["@oh-my-pi/pi-coding-agent"],
	plugins: [
		{
			name: "stub-pi-natives",
			setup(build) {
				build.onResolve({ filter: /^@oh-my-pi\/pi-natives/ }, args => ({
					path: args.path,
					namespace: "pi-natives-stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "pi-natives-stub" }, () => ({
					contents: "export const Process = {}; export const ProcessStatus = {};",
					loader: "js",
				}));
			},
		},
		{
			// `opencode-antigravity-auth/.../plugin/storage` (pulled in transitively by the
			// quota/token value imports) does `import lockfile from "proper-lockfile"`, whose
			// CJS `require("signal-exit")` expects signal-exit v3's default-function export.
			// The hoisted signal-exit@4 exports named members, so the bundled top-level
			// `onExit(...)` call crashes the extension at module-load. The adapter never
			// persists credentials through storage (its PluginClient.auth.set is a no-op),
			// so file locking is dead weight — stub it with a no-op lock/unlock/check.
			name: "stub-proper-lockfile",
			setup(build) {
				build.onResolve({ filter: /^proper-lockfile$/ }, args => ({
					path: args.path,
					namespace: "proper-lockfile-stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "proper-lockfile-stub" }, () => ({
					contents: [
						"const lock = async () => async () => {};",
						"const unlock = async () => {};",
						"const check = async () => false;",
						"export { lock, unlock, check };",
						"export default { lock, unlock, check };",
					].join("\n"),
					loader: "js",
				}));
			},
		},
	],
});

if (!result.success) {
	console.error("Bundle failed:");
	for (const log of result.logs) {
		console.error(`  ${log.level}: ${log.message}`);
	}
	process.exit(1);
}

const output = result.outputs[0];
console.log(`Built ${path.relative(root, output.path)} (${(output.size / 1024 / 1024).toFixed(2)} MB)`);

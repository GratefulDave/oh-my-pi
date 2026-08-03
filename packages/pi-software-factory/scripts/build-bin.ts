import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");

const PI_NATIVES_STUB = `
export const Ellipsis = { None: 0, Head: 1, Middle: 2, Tail: 3 };
export const KeyEventType = { Press: 0, Release: 1, Repeat: 2 };
export const ProcessStatus = { Running: 0, Exited: 1, Signaled: 2 };
export const FileType = { File: 0, Dir: 1, Symlink: 2 };
export const Process = class {};
export const FileLock = class { static tryAcquire() { return new this(); } acquired = false; release() {} };
export function fuzzyFind() { return Promise.resolve({ matches: [] }); }
export function matchesKey() { return false; }
export function parseKey() { return null; }
export function parseKittySequence() { return null; }
export function encodeSixel() { return ""; }
export function copyToClipboard() {}
export function truncateToWidth(text) { return text; }
export function visibleWidth(text) { return text.length; }
export function replaceTabs(text) { return text.replace(/\\t/g, "    "); }
export const sliceWithWidth = (text) => ({ text, width: text.length });
export function setHangulCompatJamoWidthOverride() {}
`;

// Build CLI entry points
const cliResult = await Bun.build({
	entrypoints: [path.join(root, "scripts/init.ts"), path.join(root, "scripts/doctor.ts")],
	outdir: path.join(root, "dist", "bin"),
	target: "bun",
	format: "esm",
	naming: "[name].js",
});

if (!cliResult.success) {
	console.error("CLI build failed:");
	for (const log of cliResult.logs) {
		console.error(`  ${log.level}: ${log.message}`);
	}
	process.exit(1);
}

for (const output of cliResult.outputs) {
	console.log(`Built ${path.relative(root, output.path)} (${(output.size / 1024).toFixed(1)} KB)`);
}

// Build extension bundle
const extResult = await Bun.build({
	entrypoints: [path.join(root, "src/extension.ts")],
	outdir: path.join(root, "dist"),
	target: "bun",
	format: "esm",
	naming: "factory.bundle.js",
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
					contents: PI_NATIVES_STUB,
					loader: "js",
				}));
			},
		},
	],
});

if (!extResult.success) {
	console.error("Extension bundle failed:");
	for (const log of extResult.logs) {
		console.error(`  ${log.level}: ${log.message}`);
	}
	process.exit(1);
}

const extOutput = extResult.outputs[0];
console.log(`Built ${path.relative(root, extOutput.path)} (${(extOutput.size / 1024 / 1024).toFixed(2)} MB)`);

console.log("Done.");

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
export function sliceWithWidth(text) { return { text, width: text.length }; }
export function extractSegments(line, beforeEnd, afterStart) { return { before: line.slice(0, beforeEnd), after: line.slice(afterStart), beforeWidth: beforeEnd, afterWidth: line.length - afterStart }; }
export function wrapTextWithAnsi(text) { return [text]; }
export function setHangulCompatJamoWidthOverride() {}
`;

const result = await Bun.build({
	entrypoints: [path.join(root, "src/extension.ts")],
	outdir: path.join(root, "dist"),
	target: "bun",
	format: "esm",
	naming: "swarm.bundle.js",
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

if (!result.success) {
	console.error("Bundle failed:");
	for (const log of result.logs) {
		console.error(`  ${log.level}: ${log.message}`);
	}
	process.exit(1);
}

const output = result.outputs[0];
console.log(`Built ${path.relative(root, output.path)} (${(output.size / 1024 / 1024).toFixed(2)} MB)`);

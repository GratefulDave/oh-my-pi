import * as path from "node:path";
import { build } from "bun";

const root = import.meta.dir;
const outdir = path.join(root, "../dist");
const result = await build({
	entrypoints: [path.join(root, "../src/extension.ts")],
	outdir,
	naming: {
		entry: "ag.bundle.js",
	},
	target: "bun",
	format: "esm",
	minify: false,
	sourcemap: "external",
	external: ["@oh-my-pi/pi-coding-agent"],
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log(`Built ${result.outputs.length} file(s) into ${outdir}`);

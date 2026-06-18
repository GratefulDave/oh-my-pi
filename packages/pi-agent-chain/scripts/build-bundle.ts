import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");

const result = await Bun.build({
	entrypoints: [path.join(root, "src/index.ts")],
	outdir: path.join(root, "dist"),
	target: "bun",
	format: "esm",
	naming: "agent-chain.bundle.js",
	external: ["@oh-my-pi/pi-coding-agent"],
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

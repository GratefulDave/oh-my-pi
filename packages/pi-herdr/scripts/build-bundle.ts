import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const packageJson = (await Bun.file(path.join(root, "package.json")).json()) as {
	name?: string;
	omp?: { extensions?: string[] };
};
const outputRel = packageJson.omp?.extensions?.[0];
if (!outputRel) throw new Error("package.json missing omp.extensions[0]");
const outFile = path.resolve(root, outputRel);
const result = await Bun.build({
	entrypoints: [path.join(root, "src", "extension.ts")],
	outdir: path.dirname(outFile),
	target: "bun",
	format: "esm",
	naming: path.basename(outFile),
	external: ["@oh-my-pi/pi-coding-agent"],
});
if (!result.success) {
	console.error("Bundle failed:");
	for (const log of result.logs) console.error(`  ${log.level}: ${log.message}`);
	process.exit(1);
}
const output = result.outputs[0];
console.log(`Built ${path.relative(root, output.path)} (${(output.size / 1024 / 1024).toFixed(2)} MB)`);

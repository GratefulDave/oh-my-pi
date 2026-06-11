#!/usr/bin/env bun
/**
 * factory-init — Scaffold an OMP software factory for the current project.
 * Usage: bunx pi-software-factory init [--preset standard] [--no-memory]
 */
import { scaffoldFactory } from "../src/scaffold";

const args = process.argv.slice(2);
const cwd = process.env.FACTORY_CWD ?? process.cwd();

let preset = "standard";
let enableMemory = true;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--help" || arg === "-h") {
		console.log("Usage: factory-init [--preset standard|minimal] [--no-memory]");
		process.exit(0);
	}
	if (arg === "--preset") {
		preset = args[++i] ?? "standard";
	} else if (arg === "--no-memory") {
		enableMemory = false;
	} else {
		console.error(`Unknown option: ${arg}`);
		process.exit(1);
	}
}

console.log(`Scaffolding software factory (preset: ${preset}) in ${cwd}...`);
const result = await scaffoldFactory({ cwd, preset, enableMemory });

if (result.filesWritten.length > 0) {
	console.log(`\nCreated ${result.filesWritten.length} file(s):`);
	for (const file of result.filesWritten) {
		console.log(`  ${file}`);
	}
}

if (result.errors.length > 0) {
	console.log(`\nErrors (${result.errors.length}):`);
	for (const err of result.errors) {
		console.log(`  ${err.target}: ${err.error}`);
	}
	process.exit(1);
}

console.log("\nDone. Run 'factory-doctor' to verify the setup.");

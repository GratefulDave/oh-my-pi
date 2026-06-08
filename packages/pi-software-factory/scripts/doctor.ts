#!/usr/bin/env bun
/**
 * factory-doctor — Verify an OMP software factory setup.
 * Usage: bunx pi-software-factory doctor
 */
import { runFactoryDoctor } from "../src/doctor";

const cwd = process.env.FACTORY_CWD ?? process.cwd();

console.log(`Checking factory setup in ${cwd}...\n`);
const result = await runFactoryDoctor(cwd);

const icon = (ok: boolean) => (ok ? "✓" : "✗");

for (const check of result.checks) {
	const prefix = icon(check.ok);
	console.log(`  ${prefix} ${check.message}`);
}

console.log(`\nResult: ${result.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
process.exit(result.ok ? 0 : 1);

#!/usr/bin/env bun

// Syncs ALL @oh-my-pi/* package versions across the monorepo.
//
// Usage:
//   bun scripts/sync-versions.ts              -- verify lockstep + sync deps
//   bun scripts/sync-versions.ts 15.7.3-lex   -- set version everywhere + sync deps
//
// Updates:
//   - each packages/ package.json  (version field)
//   - root package.json catalog entries
//   - crates/pi-natives/src/lib.rs  (version sentinel js_name)
//   - packages/natives/native/index.js  (sentinel re-export)
//   - packages/natives/native/index.d.ts  (sentinel declaration)
import { readdirSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface PackageInfo {
	path: string;
	data: PackageJson;
}

const root = process.cwd();
const packagesDir = join(root, "packages");
const newVersion: string | undefined = process.argv[2];

// ── 1. Read all workspace package.json files ──────────────────────────────────

const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);

const packages: Record<string, PackageInfo> = {};
const versionMap: Record<string, string> = {};

for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, "package.json");
	try {
		const pkg = (await Bun.file(pkgPath).json()) as PackageJson;
		packages[dir] = { path: pkgPath, data: pkg };
		versionMap[pkg.name] = pkg.version;
	} catch {
		// no package.json — skip
	}
}

// ── 2. If a version arg was given, stamp it on every workspace package ────────

if (newVersion) {
	console.log(`\nSetting all @oh-my-pi/* packages to ${newVersion}`);
	for (const [, pkg] of Object.entries(packages)) {
		if (pkg.data.version !== newVersion) {
			console.log(`  ${pkg.data.name}: ${pkg.data.version} → ${newVersion}`);
			pkg.data.version = newVersion;
			versionMap[pkg.data.name] = newVersion;
		}
	}

	// Write updated package.json files
	for (const [, pkg] of Object.entries(packages)) {
		await Bun.write(pkg.path, JSON.stringify(pkg.data, null, "\t") + "\n");
	}

	// ── 2a. Update root catalog ───────────────────────────────────────────────
	const rootPkgPath = join(root, "package.json");
	const rootPkg = (await Bun.file(rootPkgPath).json()) as {
		catalog?: Record<string, string>;
	};
	let catalogUpdates = 0;
	if (rootPkg.catalog) {
		for (const name of Object.keys(rootPkg.catalog)) {
			if (versionMap[name] !== undefined && rootPkg.catalog[name] !== newVersion) {
				rootPkg.catalog[name] = newVersion;
				catalogUpdates++;
			}
		}
		if (catalogUpdates > 0) {
			await Bun.write(rootPkgPath, JSON.stringify(rootPkg, null, "\t") + "\n");
			console.log(`  root catalog: ${catalogUpdates} entr${catalogUpdates === 1 ? "y" : "ies"} updated`);
		}
	}

	// ── 2b. Update Rust sentinel in crates/pi-natives/src/lib.rs ─────────────
	const sentinelName = `__piNativesV${newVersion.replace(/[^A-Za-z0-9]/g, "_")}`;
	const libRsPath = join(root, "crates/pi-natives/src/lib.rs");
	const libRs = await Bun.file(libRsPath).text();
	const updatedLibRs = libRs.replace(
		/#\[napi\(js_name = "__piNativesV[A-Za-z0-9_]+"\)\]/,
		`#[napi(js_name = "${sentinelName}")]`,
	);
	if (updatedLibRs !== libRs) {
		await Bun.write(libRsPath, updatedLibRs);
		console.log(`  crates/pi-natives/src/lib.rs: sentinel → ${sentinelName}`);
	}

	// ── 2c. Update sentinel re-export in packages/natives/native/index.js ────
	const indexJsPath = join(root, "packages/natives/native/index.js");
	const indexJs = await Bun.file(indexJsPath).text();
	const updatedIndexJs = indexJs.replace(
		/export const __piNativesV[A-Za-z0-9_]+ = nativeBindings\.__piNativesV[A-Za-z0-9_]+;/,
		`export const ${sentinelName} = nativeBindings.${sentinelName};`,
	);
	if (updatedIndexJs !== indexJs) {
		await Bun.write(indexJsPath, updatedIndexJs);
		console.log(`  packages/natives/native/index.js: sentinel → ${sentinelName}`);
	}

	// ── 2d. Update sentinel declaration in packages/natives/native/index.d.ts ─
	const indexDtsPath = join(root, "packages/natives/native/index.d.ts");
	const indexDts = await Bun.file(indexDtsPath).text();
	const updatedIndexDts = indexDts.replace(
		/export declare function __piNativesV[A-Za-z0-9_]+\(\): void/,
		`export declare function ${sentinelName}(): void`,
	);
	if (updatedIndexDts !== indexDts) {
		await Bun.write(indexDtsPath, updatedIndexDts);
		console.log(`  packages/natives/native/index.d.ts: sentinel → ${sentinelName}`);
	}
} else {
	console.log("Current versions:");
	for (const [name, version] of Object.entries(versionMap).sort()) {
		console.log(`  ${name}: ${version}`);
	}
}

// ── 3. Verify lockstep ────────────────────────────────────────────────────────

const versions = new Set(Object.values(versionMap));
if (versions.size > 1) {
	console.error("\n❌ Not all packages have the same version:");
	for (const [name, version] of Object.entries(versionMap).sort()) {
		console.error(`  ${name}: ${version}`);
	}
	console.error("\nRun: bun scripts/sync-versions.ts <version>");
	process.exit(1);
}

console.log("\n✅ All packages at same version (lockstep)");

// ── 4. Sync inter-package dependency versions ─────────────────────────────────

let totalUpdates = 0;
for (const [, pkg] of Object.entries(packages)) {
	let updated = false;

	for (const depGroup of ["dependencies", "devDependencies"] as const) {
		const deps = pkg.data[depGroup];
		if (!deps) continue;
		for (const [depName, currentVersion] of Object.entries(deps)) {
			if (versionMap[depName] === undefined) continue;
			const newDepVersion = `^${versionMap[depName]}`;
			if (currentVersion !== newDepVersion) {
				console.log(`  ${pkg.data.name} ${depGroup}: ${depName} ${currentVersion} → ${newDepVersion}`);
				deps[depName] = newDepVersion;
				updated = true;
				totalUpdates++;
			}
		}
	}

	if (updated) {
		await Bun.write(pkg.path, JSON.stringify(pkg.data, null, "\t") + "\n");
	}
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies already in sync.");
} else {
	console.log(`\n✅ Updated ${totalUpdates} dependency version(s)`);
}

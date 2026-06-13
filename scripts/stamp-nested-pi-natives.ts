/**
 * Stamps the @oh-my-pi/pi-natives version into all nested node_modules copies
 * that shadow the workspace symlink. Called by rebuild-lex.zsh before binary
 * compilation to ensure the bundled version string matches the fork version.
 *
 * Without this, the binary embeds the upstream version (e.g. "15.11.7")
 * from a nested node_modules copy, causing the native loader to look in
 * ~/.omp/natives/15.11.7/ instead of ~/.omp/natives/15.11.7-lex/.
 */

import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const canonicalPkg = path.join(repoRoot, "packages/natives/package.json");
const { version } = (await Bun.file(canonicalPkg).json()) as { version: string };

// Glob all nested pi-natives package.json copies under packages/
const glob = new Bun.Glob("packages/**/node_modules/@oh-my-pi/pi-natives/package.json");
const paths: string[] = [];
for await (const p of glob.scan({ cwd: repoRoot, followSymlinks: false })) {
	const abs = path.join(repoRoot, p);
	if (abs !== canonicalPkg) paths.push(abs);
}

let stamped = 0;
for (const p of paths) {
	try {
		const pkg = await Bun.file(p).json();
		if (pkg.version === version) continue;
		pkg.version = version;
		await Bun.write(p, JSON.stringify(pkg, null, "\t") + "\n");
		console.log(`  stamped ${path.relative(repoRoot, p)} → ${version}`);
		stamped++;
	} catch {
		// skip unreadable files
	}
}

if (stamped === 0) {
	console.log(`  all nested copies already at ${version}`);
}

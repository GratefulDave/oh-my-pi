import * as path from "node:path";
import * as fs from "node:fs/promises";

export function assertWithinCwd(cwd: string, targetPath: string): string {
	const resolvedCwd = path.resolve(cwd);
	const resolvedTarget = path.resolve(targetPath);
	const relative = path.relative(resolvedCwd, resolvedTarget);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		return resolvedTarget;
	}
	throw new Error(`Refusing to access path outside cwd: ${resolvedTarget}`);
}

export function getSemanticSearchDir(cwd: string): string {
	return assertWithinCwd(cwd, path.join(cwd, ".omp", "semantic-search"));
}

export function getSemanticSearchDbPath(cwd: string): string {
	return assertWithinCwd(cwd, path.join(getSemanticSearchDir(cwd), "index.db"));
}

export async function ensureSemanticSearchDir(cwd: string): Promise<string> {
	const dir = getSemanticSearchDir(cwd);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

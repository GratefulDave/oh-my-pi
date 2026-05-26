import * as path from "node:path";
import process from "node:process";

const DEFAULT_CMD = process.platform === "win32" ? "lex.cmd" : "lex";
const DEFAULT_SHELL = process.platform === "win32";

export interface FactoryOmpCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

export function getOmpDir(cwd: string): string {
	return path.join(cwd, ".omp");
}

export function getFactoryDir(cwd: string): string {
	return path.join(getOmpDir(cwd), "factory");
}

export function getFactoryExtensionDir(cwd: string): string {
	return path.join(getOmpDir(cwd), "extensions", "software-factory");
}

export function resolveRepoScopedPath(baseDir: string, maybeRelativePath: string): string {
	if (path.isAbsolute(maybeRelativePath)) return path.normalize(maybeRelativePath);
	return path.normalize(path.join(baseDir, maybeRelativePath));
}

export function isPathWithinRepo(cwd: string, candidatePath: string): boolean {
	const repoRoot = path.resolve(cwd);
	const resolved = path.resolve(candidatePath);
	return resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`);
}

export function toRepoRelative(cwd: string, candidatePath: string): string {
	const relative = path.relative(cwd, candidatePath);
	return relative.length === 0 ? "." : relative;
}

export function normalizePathForMatch(cwd: string, candidatePath: string): string {
	const absolute = path.isAbsolute(candidatePath) ? candidatePath : path.join(cwd, candidatePath);
	return toRepoRelative(cwd, absolute).replace(/\\/g, "/");
}

export function resolveFactoryOmpCommand(): FactoryOmpCommand {
	const envCmd = process.env.PI_SUBPROCESS_CMD?.trim();
	if (envCmd) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}

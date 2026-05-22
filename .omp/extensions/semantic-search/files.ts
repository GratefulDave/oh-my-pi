import * as fs from "node:fs/promises";
import * as path from "node:path";
import { globPaths } from "@oh-my-pi/pi-utils";
import type { FileFingerprint, SemanticLanguage } from "./types";

const SOURCE_PATTERNS = [
	"**/*.ts",
	"**/*.tsx",
	"**/*.mts",
	"**/*.cts",
	"**/*.js",
	"**/*.jsx",
	"**/*.mjs",
	"**/*.cjs",
	"**/*.py",
	"**/*.rs",
	"**/*.go",
	"**/*.java",
	"**/*.kt",
	"**/*.swift",
	"**/*.md",
	"**/*.txt",
];

const DEFAULT_EXCLUDES = [
	".omp",
	".omp/**",
	".omc",
	".omc/**",
	".omx",
	".omx/**",
	".agents",
	".agents/**",
	".claude",
	".claude/**",
	".codex",
	".codex/**",
	".cursor",
	".cursor/**",
	".zed",
	".zed/**",
	".idea",
	".idea/**",
	"**/.omp",
	"**/.omp/**",
	"**/.omc",
	"**/.omc/**",
	"**/.omx",
	"**/.omx/**",
	"**/.agents",
	"**/.agents/**",
	"**/.claude",
	"**/.claude/**",
	"**/.codex",
	"**/.codex/**",
	"**/.cursor",
	"**/.cursor/**",
	"**/.zed",
	"**/.zed/**",
	"**/.idea",
	"**/.idea/**",
	".venv",
	".venv/**",
	"**/.venv",
	"**/.venv/**",
	"venv",
	"venv/**",
	"**/venv",
	"**/venv/**",
	"**/site-packages",
	"**/site-packages/**",
	"**/__generated__",
	"**/__generated__/**",
	"**/*.gen.ts",
	"dist",
	"dist/**",
	"build",
	"build/**",
	"coverage",
	"coverage/**",
	"target",
	"target/**",
	".next",
	".next/**",
	".turbo",
	".turbo/**",
	"*.min.js",
];

const MAX_FILE_BYTES = 512 * 1024;

export async function discoverSourceFiles(cwd: string): Promise<string[]> {
	const files = await globPaths(SOURCE_PATTERNS, {
		cwd,
		gitignore: true,
		dot: true,
		exclude: DEFAULT_EXCLUDES,
		onlyFiles: true,
		timeoutMs: 30_000,
	});
	files.sort((left, right) => left.localeCompare(right));
	return files;
}

export async function readFileFingerprint(cwd: string, relativePath: string): Promise<FileFingerprint | null> {
	const absolutePath = path.join(cwd, relativePath);
	const stat = await fs.stat(absolutePath);
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
		return null;
	}
	const content = await Bun.file(absolutePath).text();
	return {
		path: relativePath,
		fileHash: hashText(content),
		mtimeMs: stat.mtimeMs,
		sizeBytes: stat.size,
	};
}

export async function readTextFile(cwd: string, relativePath: string): Promise<{ text: string; mtimeMs: number; sizeBytes: number } | null> {
	const absolutePath = path.join(cwd, relativePath);
	const stat = await fs.stat(absolutePath);
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
		return null;
	}
	const text = await Bun.file(absolutePath).text();
	return { text, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
}

export function detectLanguage(relativePath: string): SemanticLanguage {
	const ext = path.extname(relativePath).toLowerCase();
	switch (ext) {
		case ".ts":
		case ".tsx":
		case ".mts":
		case ".cts":
			return "typescript";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".py":
			return "python";
		case ".rs":
			return "rust";
		case ".go":
			return "go";
		case ".java":
			return "java";
		case ".kt":
			return "kotlin";
		case ".swift":
			return "swift";
		case ".md":
			return "markdown";
		default:
			return "text";
	}
}

export function hashText(text: string): string {
	return Bun.hash(text).toString(16);
}

export async function mapLimit<TItem, TResult>(
	items: TItem[],
	limit: number,
	worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
	if (items.length === 0) {
		return [];
	}
	const boundedLimit = Math.max(1, Math.min(limit, items.length));
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;
	const runWorker = async () => {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) {
				return;
			}
			results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
		}
	};
	await Promise.all(Array.from({ length: boundedLimit }, () => runWorker()));
	return results;
}

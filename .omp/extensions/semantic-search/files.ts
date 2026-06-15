import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type { FileFingerprint, SemanticLanguage } from "./types";

const SOURCE_EXTENSIONS: Record<string, true> = {
	".ts": true,
	".tsx": true,
	".mts": true,
	".cts": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".py": true,
	".rs": true,
	".go": true,
	".java": true,
	".kt": true,
	".swift": true,
	".md": true,
	".txt": true,
};

const EXCLUDED_DIR_NAMES: Record<string, true> = {
	".git": true,
	".omp": true,
	".omc": true,
	".omx": true,
	".agents": true,
	".claude": true,
	".codex": true,
	".cursor": true,
	".zed": true,
	".idea": true,
	".venv": true,
	"venv": true,
	"site-packages": true,
	"__generated__": true,
	dist: true,
	build: true,
	coverage: true,
	target: true,
	".next": true,
	".turbo": true,
};

const MAX_FILE_BYTES = 512 * 1024;

export async function discoverSourceFiles(cwd: string): Promise<string[]> {
	const files: string[] = [];
	await collectSourceFiles(cwd, "", files);
	files.sort((left, right) => left.localeCompare(right));
	return files;
}

async function collectSourceFiles(cwd: string, relativeDir: string, files: string[]): Promise<void> {
	const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(absoluteDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (EXCLUDED_DIR_NAMES[entry.name]) continue;
			await collectSourceFiles(cwd, relativePath, files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (entry.name.endsWith(".min.js") || entry.name.endsWith(".gen.ts")) continue;
		if (!SOURCE_EXTENSIONS[path.extname(entry.name)]) continue;
		files.push(relativePath);
	}
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

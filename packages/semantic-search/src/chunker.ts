import { parse } from "@babel/parser";
import { detectLanguage, hashText } from "./files";
import type { ChunkKind, ChunkRecord, SemanticLanguage } from "./types";

interface AstLikeNode {
	type?: string;
	id?: { name?: string } | null;
	key?: { name?: string } | { value?: string } | null;
	loc?: {
		start: { line: number };
		end: { line: number };
	} | null;
	declaration?: AstLikeNode | null;
	declarations?: AstLikeNode[];
	init?: AstLikeNode | null;
	body?: { body?: AstLikeNode[] } | AstLikeNode[] | null;
	value?: AstLikeNode | null;
	left?: AstLikeNode | null;
	right?: AstLikeNode | null;
	properties?: AstLikeNode[];
}

interface ChunkSeed {
	kind: ChunkKind;
	symbol: string | null;
	startLine: number;
	endLine: number;
}

export function chunkFile(relativePath: string, sourceText: string, fileHash: string): ChunkRecord[] {
	const language = detectLanguage(relativePath);
	const seeds =
		language === "typescript" || language === "javascript"
			? extractJavaScriptSeeds(sourceText)
			: language === "markdown"
				? extractMarkdownSeeds(sourceText)
				: [];
	const finalSeeds = seeds.length > 0 ? mergeFallbackSeeds(sourceText, seeds) : createWindowSeeds(sourceText, language);
	return finalSeeds.map((seed, index) => {
		const content = sliceLines(sourceText, seed.startLine, seed.endLine).trimEnd();
		const contentHash = hashText(content);
		const chunkId = `${relativePath}:${seed.startLine}-${seed.endLine}:${contentHash}:${index}`;
		return {
			chunkId,
			path: relativePath,
			language,
			kind: seed.kind,
			symbol: seed.symbol,
			startLine: seed.startLine,
			endLine: seed.endLine,
			content,
			contentHash,
			fileHash,
		};
	});
}

function extractJavaScriptSeeds(sourceText: string): ChunkSeed[] {
	let ast: { program?: { body?: AstLikeNode[] } };
	try {
		ast = parse(sourceText, {
			sourceType: "unambiguous",
			allowReturnOutsideFunction: true,
			errorRecovery: true,
			plugins: [
				"typescript",
				"jsx",
				"decorators-legacy",
				"classProperties",
				"classPrivateProperties",
				"classPrivateMethods",
				"importAttributes",
				"objectRestSpread",
				"topLevelAwait",
			],
		}) as unknown as { program?: { body?: AstLikeNode[] } };
	} catch {
		return [];
	}
	const seeds: ChunkSeed[] = [];
	for (const statement of ast.program?.body ?? []) {
		collectStatementSeeds(statement, seeds, undefined);
	}
	return normalizeSeeds(seeds);
}

function collectStatementSeeds(node: AstLikeNode | null | undefined, seeds: ChunkSeed[], className: string | undefined): void {
	if (!node?.type) {
		return;
	}
	if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
		collectStatementSeeds(node.declaration, seeds, className);
		return;
	}
	if (node.type === "FunctionDeclaration") {
		pushSeed(seeds, "function", node.id?.name ?? "<anonymous>", node);
		return;
	}
	if (node.type === "ClassDeclaration") {
		const nextClassName = node.id?.name ?? className ?? "<anonymous-class>";
		const body = Array.isArray(node.body) ? node.body : node.body?.body ?? [];
		let methodCount = 0;
		for (const member of body) {
			methodCount += collectClassMemberSeeds(member, seeds, nextClassName);
		}
		if (methodCount === 0) {
			pushSeed(seeds, "class", nextClassName, node);
		}
		return;
	}
	if (node.type === "VariableDeclaration") {
		for (const declaration of node.declarations ?? []) {
			collectVariableSeed(declaration, seeds);
		}
		return;
	}
}

function collectVariableSeed(node: AstLikeNode, seeds: ChunkSeed[]): void {
	const symbol = node.id?.name;
	if (!symbol || !node.init?.type) {
		return;
	}
	if (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression") {
		pushSeed(seeds, "function", symbol, node);
		return;
	}
	if (node.init.type === "ClassExpression") {
		pushSeed(seeds, "class", symbol, node);
		const body = Array.isArray(node.init.body) ? node.init.body : node.init.body?.body ?? [];
		for (const member of body) {
			collectClassMemberSeeds(member, seeds, symbol);
		}
		return;
	}
	if (node.init.type === "ObjectExpression") {
		for (const property of node.init.properties ?? []) {
			if (property.type === "ObjectMethod") {
				const propertyName = getPropertyName(property);
				pushSeed(seeds, "method", propertyName ? `${symbol}.${propertyName}` : symbol, property);
				continue;
			}
			if (property.type === "ObjectProperty" && property.value?.type === "ArrowFunctionExpression") {
				const propertyName = getPropertyName(property);
				pushSeed(seeds, "method", propertyName ? `${symbol}.${propertyName}` : symbol, property);
			}
		}
	}
}

function collectClassMemberSeeds(node: AstLikeNode, seeds: ChunkSeed[], className: string): number {
	if (!node.type) {
		return 0;
	}
	if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "TSDeclareMethod") {
		const propertyName = getPropertyName(node) ?? "<method>";
		pushSeed(seeds, "method", `${className}.${propertyName}`, node);
		return 1;
	}
	if ((node.type === "ClassProperty" || node.type === "ClassPrivateProperty") && node.value?.type === "ArrowFunctionExpression") {
		const propertyName = getPropertyName(node) ?? "<property>";
		pushSeed(seeds, "method", `${className}.${propertyName}`, node);
		return 1;
	}
	return 0;
}

function getPropertyName(node: AstLikeNode): string | null {
	const key = node.key;
	if (!key) {
		return null;
	}
	if ("name" in key && typeof key.name === "string" && key.name.length > 0) {
		return key.name;
	}
	if ("value" in key && typeof key.value === "string" && key.value.length > 0) {
		return key.value;
	}
	return null;
}

function pushSeed(seeds: ChunkSeed[], kind: ChunkKind, symbol: string | null, node: AstLikeNode): void {
	const startLine = node.loc?.start.line;
	const endLine = node.loc?.end.line;
	if (!startLine || !endLine || endLine < startLine) {
		return;
	}
	seeds.push({ kind, symbol, startLine, endLine });
}

function normalizeSeeds(seeds: ChunkSeed[]): ChunkSeed[] {
	const seen = new Set<string>();
	const ordered = [...seeds].sort((left, right) => {
		if (left.startLine !== right.startLine) {
			return left.startLine - right.startLine;
		}
		return left.endLine - right.endLine;
	});
	const normalized: ChunkSeed[] = [];
	for (const seed of ordered) {
		const key = `${seed.kind}:${seed.symbol ?? ""}:${seed.startLine}:${seed.endLine}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		normalized.push(seed);
	}
	return normalized;
}

function extractMarkdownSeeds(sourceText: string): ChunkSeed[] {
	const lines = sourceText.split(/\r?\n/);
	const seeds: ChunkSeed[] = [];
	let startLine = 1;
	let heading = "document";
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.startsWith("#")) {
			continue;
		}
		if (index + 1 > startLine) {
			seeds.push({ kind: "section", symbol: heading, startLine, endLine: index });
		}
		heading = line.replace(/^#+\s*/, "").trim() || "section";
		startLine = index + 1;
	}
	if (lines.length > 0) {
		seeds.push({ kind: "section", symbol: heading, startLine, endLine: lines.length });
	}
	return normalizeSeeds(seeds);
}

function mergeFallbackSeeds(sourceText: string, primarySeeds: ChunkSeed[]): ChunkSeed[] {
	const lines = sourceText.split(/\r?\n/);
	const covered = new Array<boolean>(lines.length + 1).fill(false);
	for (const seed of primarySeeds) {
		for (let line = seed.startLine; line <= seed.endLine; line += 1) {
			covered[line] = true;
		}
	}
	const merged = [...primarySeeds];
	let start: number | null = null;
	for (let line = 1; line <= lines.length; line += 1) {
		const content = lines[line - 1] ?? "";
		const active = !covered[line] && content.trim().length > 0;
		if (active && start === null) {
			start = line;
			continue;
		}
		if (!active && start !== null) {
			maybePushFallback(merged, lines, start, line - 1);
			start = null;
		}
	}
	if (start !== null) {
		maybePushFallback(merged, lines, start, lines.length);
	}
	return normalizeSeeds(merged);
}

function maybePushFallback(seeds: ChunkSeed[], lines: string[], startLine: number, endLine: number): void {
	if (endLine < startLine) {
		return;
	}
	const content = lines.slice(startLine - 1, endLine).join("\n").trim();
	if (content.length < 40) {
		return;
	}
	seeds.push({ kind: "module", symbol: null, startLine, endLine });
}

function createWindowSeeds(sourceText: string, language: SemanticLanguage): ChunkSeed[] {
	const lines = sourceText.split(/\r?\n/);
	if (lines.length === 0) {
		return [];
	}
	const windowSize = language === "markdown" ? 60 : 80;
	const overlap = 12;
	const seeds: ChunkSeed[] = [];
	for (let startLine = 1; startLine <= lines.length; startLine += Math.max(1, windowSize - overlap)) {
		const endLine = Math.min(lines.length, startLine + windowSize - 1);
		seeds.push({ kind: "window", symbol: null, startLine, endLine });
		if (endLine === lines.length) {
			break;
		}
	}
	return seeds;
}

function sliceLines(sourceText: string, startLine: number, endLine: number): string {
	return sourceText
		.split(/\r?\n/)
		.slice(startLine - 1, endLine)
		.join("\n");
}

import type { IndexBuildStats, IndexStatus, SearchResponse, SearchResult } from "./types";

export interface ParsedIndexCommandArgs {
	action: "build" | "rebuild" | "status";
	computeEmbeddings: boolean;
	embeddingModel?: string;
	embeddingBaseUrl?: string;
	concurrency?: number;
}

export interface ParsedSearchCommandArgs {
	query: string;
	limit: number;
	decompose: boolean;
	rerank: boolean;
	embeddingModel?: string;
	embeddingBaseUrl?: string;
}

export function parseIndexCommandArgs(args: string): ParsedIndexCommandArgs {
	const tokens = splitArgs(args);
	let action: ParsedIndexCommandArgs["action"] = "build";
	let computeEmbeddings = false;
	let embeddingModel: string | undefined;
	let embeddingBaseUrl: string | undefined;
	let concurrency: number | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token === "build" || token === "rebuild" || token === "status") {
			action = token;
			continue;
		}
		if (token === "--embeddings") {
			computeEmbeddings = true;
			continue;
		}
		if (token === "--model") {
			embeddingModel = tokens[index + 1];
			index += 1;
			continue;
		}
		if (token === "--base-url") {
			embeddingBaseUrl = tokens[index + 1];
			index += 1;
			continue;
		}
		if (token === "--concurrency") {
			const parsed = Number.parseInt(tokens[index + 1] ?? "", 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				concurrency = parsed;
			}
			index += 1;
		}
	}
	return { action, computeEmbeddings, embeddingModel, embeddingBaseUrl, concurrency };
}

export function parseSearchCommandArgs(args: string): ParsedSearchCommandArgs {
	const tokens = splitArgs(args);
	const queryParts: string[] = [];
	let limit = 10;
	let decompose = true;
	let rerank = true;
	let embeddingModel: string | undefined;
	let embeddingBaseUrl: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token === "--limit") {
			const parsed = Number.parseInt(tokens[index + 1] ?? "", 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				limit = parsed;
			}
			index += 1;
			continue;
		}
		if (token === "--no-decompose") {
			decompose = false;
			continue;
		}
		if (token === "--rerank") {
			rerank = true;
			continue;
		}
		if (token === "--no-rerank") {
			rerank = false;
			continue;
		}
		if (token === "--model") {
			embeddingModel = tokens[index + 1];
			index += 1;
			continue;
		}
		if (token === "--base-url") {
			embeddingBaseUrl = tokens[index + 1];
			index += 1;
			continue;
		}
		queryParts.push(token);
	}
	return {
		query: queryParts.join(" ").trim(),
		limit,
		decompose,
		rerank,
		embeddingModel,
		embeddingBaseUrl,
	};
}

export function formatBuildStats(stats: IndexBuildStats): string {
	const lines = [
		`Semantic index ready at ${stats.dbPath}`,
		`cwd: ${stats.cwd}`,
		`files discovered: ${stats.filesDiscovered}`,
		`files indexed: ${stats.filesIndexed}`,
		`files skipped: ${stats.filesSkipped}`,
		`files removed: ${stats.filesRemoved}`,
		`chunks upserted: ${stats.chunksUpserted}`,
	];
	if (stats.embeddingsUpdated > 0) {
		lines.push(`embeddings updated: ${stats.embeddingsUpdated}`);
	}
	return lines.join("\n");
}

export function formatStatus(status: IndexStatus): string {
	return [
		`Semantic index status`,
		`cwd: ${status.cwd}`,
		`db: ${status.dbPath}`,
		`files: ${status.files}`,
		`chunks: ${status.chunks}`,
		`embeddings: ${status.embeddings}`,
		`last indexed: ${status.lastIndexedAt ? new Date(status.lastIndexedAt).toISOString() : "never"}`,
	].join("\n");
}

export function formatSearchResponse(response: SearchResponse): string {
	if (response.results.length === 0) {
		return `No semantic search results for: ${response.query}`;
	}
	const lines = [
		`Semantic search results for: ${response.query}`,
		response.queries.length > 1 ? `queries: ${response.queries.join(" | ")}` : undefined,
		response.reranked
			? `reranked: embeddings (${response.rerankInfo?.model ?? "unknown-model"} @ ${response.rerankInfo?.baseUrl ?? "unknown-endpoint"})`
			: undefined,
		"",
		...response.results.map((result, index) => formatSearchResult(result, index + 1)),
	].filter((line): line is string => typeof line === "string");
	return lines.join("\n");
}

function formatSearchResult(result: SearchResult, index: number): string {
	const header = `${index}. ${result.path}:${result.startLine}-${result.endLine}${result.symbol ? ` • ${result.symbol}` : ""}`;
	const score = `   kind=${result.kind} score=${result.finalScore.toFixed(2)}${
		result.embeddingScore === null ? "" : ` embedding=${result.embeddingScore.toFixed(3)}`
	}`;
	const snippet = indent(preview(result.content), "   ");
	return [header, score, snippet].join("\n");
}

function preview(content: string): string {
	const lines = content
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.filter(line => line.trim().length > 0)
		.slice(0, 8);
	return lines.join("\n");
}

function indent(content: string, prefix: string): string {
	return content
		.split(/\r?\n/)
		.map(line => `${prefix}${line}`)
		.join("\n");
}

function splitArgs(input: string): string[] {
	const tokens = input.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
	return tokens.map(token => token.replace(/^("|')|("|')$/g, ""));
}

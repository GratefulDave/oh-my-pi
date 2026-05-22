import type * as zod from "zod/v4";
import { formatBuildStats, formatSearchResponse, formatStatus, parseIndexCommandArgs, parseSearchCommandArgs } from "./commands";
import { renderSemanticSearchMessage } from "./renderers";
import { SemanticSearchService } from "./service";

export default function semanticSearchExtension(pi: {
	zod: typeof zod;
	registerCommand: (name: string, options: {
		description?: string;
		getArgumentCompletions?: (argumentPrefix: string) => Array<{ label: string; value: string; detail?: string }> | null;
		handler: (args: string, ctx: {
			cwd: string;
			ui: {
				notify(message: string, type?: "info" | "warning" | "error"): void;
				setStatus?(key: string, text: string | undefined): void;
				setWorkingMessage?(message?: string): void;
				setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
			};
		}) => Promise<void>;
	}) => void;
	registerMessageRenderer: (
		customType: string,
		renderer: (
			message: { customType: string; content: string },
			options: { expanded: boolean },
			theme: {
				bg(name: string, text: string): string;
				fg(name: string, text: string): string;
				bold(text: string): string;
			},
		) => { render(width: number): string[] },
	) => void;
	registerTool: (tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: {
				query: string;
				limit?: number;
				decompose?: boolean;
				rerank?: boolean;
				embeddingModel?: string;
				embeddingBaseUrl?: string;
			},
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: { cwd: string },
		) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
	}) => void;
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => void;
	setLabel: (label: string) => void;
	logger: { error(message: string, context?: Record<string, unknown>): void };
}): void {
	const { z } = pi.zod;
	const service = new SemanticSearchService();
	pi.setLabel("Local Semantic Search");

	const sendText = (
		customType: string,
		text: string,
		details?: unknown,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => {
		pi.sendMessage({ customType, content: text, display: true, details }, options);
	};



	pi.registerMessageRenderer("semantic-search-results", renderSemanticSearchMessage);
	pi.registerTool({
		name: "local_semantic_search",
		label: "Semantic Search",
		description:
			"Searches a cwd-local semantic index built under .omp/semantic-search using FTS5 retrieval with default embedding rerank.",
		parameters: z.object({
			query: z.string().min(1),
			limit: z.number().int().min(1).max(25).optional(),
			decompose: z.boolean().optional(),
			rerank: z.boolean().optional().describe("Defaults to true. Pass false to disable embedding rerank."),
			embeddingModel: z.string().optional(),
			embeddingBaseUrl: z.string().url().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const response = await service.search(ctx.cwd, params.query, {
				limit: params.limit,
				decompose: params.decompose,
				rerank: params.rerank,
				embeddingModel: params.embeddingModel,
				embeddingBaseUrl: params.embeddingBaseUrl,
			});
			return {
				content: [{ type: "text", text: formatSearchResponse(response) }],
				details: response,
			};
		},
	});

	pi.registerCommand("semantic-index", {
		description: "Build, rebuild, or inspect the cwd-local semantic search index.",
		getArgumentCompletions(prefix) {
			if (!prefix.includes(" ")) {
				return [
					{ label: "build", value: "build", detail: "Incremental build" },
					{ label: "rebuild", value: "rebuild", detail: "Full rebuild" },
					{ label: "status", value: "status", detail: "Show index status" },
				].filter(item => item.value.startsWith(prefix));
			}
			return null;
		},
		async handler(args, ctx) {
			const setProgress = (message: string | undefined): void => {
				ctx.ui.setStatus?.("semantic-search-index", message);
				ctx.ui.setWorkingMessage?.(message);
			};
			const setProgressWidget = (
				progress:
					| {
							stage: "discover" | "chunk" | "persist" | "embed" | "done";
							message: string;
							filesDiscovered?: number;
							filesProcessed?: number;
							filesIndexed?: number;
							embeddingsUpdated?: number;
							embeddingsTotal?: number;
					  }
					| undefined,
			): void => {
				ctx.ui.setWidget?.("semantic-search-index", progress ? buildProgressWidgetLines(progress) : undefined, {
					placement: "belowEditor",
				});
			};
			try {
				const parsed = parseIndexCommandArgs(args);
				if (parsed.action === "status") {
					const status = await service.readStatus(ctx.cwd);
					sendText("semantic-index-status", formatStatus(status), status);
					return;
				}
				ctx.ui.notify(`Building semantic index in ${ctx.cwd}`, "info");
				setProgress("Starting semantic index build...");
				setProgressWidget({ stage: "discover", message: "Starting semantic index build..." });
				const stats = await service.buildIndex(ctx.cwd, {
					rebuild: parsed.action === "rebuild",
					computeEmbeddings: parsed.computeEmbeddings,
					embeddingModel: parsed.embeddingModel,
					embeddingBaseUrl: parsed.embeddingBaseUrl,
					concurrency: parsed.concurrency,
					onProgress(progress) {
						setProgress(progress.message);
						setProgressWidget(progress);
					},
				});
				sendText("semantic-index-build", formatBuildStats(stats), stats);
				ctx.ui.notify("Semantic index build complete", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				pi.logger.error("semantic-index command failed", { error: message });
			} finally {
				setProgress(undefined);
				setProgressWidget(undefined);
			}
		},
	});

	pi.registerCommand("semantic-search", {
		description: "Search the cwd-local semantic index with embedding rerank enabled by default.",
		async handler(args, ctx) {
			try {
				const parsed = parseSearchCommandArgs(args);
				if (!parsed.query) {
					ctx.ui.notify("Usage: /semantic-search <query> [--limit N] [--no-rerank] [--no-decompose]", "warning");
					return;
				}
				const response = await service.search(ctx.cwd, parsed.query, parsed);
				if (response.reranked && response.rerankInfo) {
					ctx.ui.notify(
						`Semantic search reranked with ${response.rerankInfo.model} @ ${response.rerankInfo.baseUrl}`,
						"info",
					);
				}
				sendText("semantic-search-results", formatSearchResponse(response), response, { triggerTurn: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				pi.logger.error("semantic-search command failed", { error: message });
			}
		},
	});

	pi.registerCommand("semantic-status", {
		description: "Show cwd-local semantic index status.",
		async handler(_args, ctx) {
			try {
				const status = await service.readStatus(ctx.cwd);
				sendText("semantic-index-status", formatStatus(status), status);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				pi.logger.error("semantic-status command failed", { error: message });
			}
		},
	});
}

function buildProgressWidgetLines(progress: {
	stage: "discover" | "chunk" | "persist" | "embed" | "done";
	message: string;
	filesDiscovered?: number;
	filesProcessed?: number;
	filesIndexed?: number;
	embeddingsUpdated?: number;
	embeddingsTotal?: number;
}): string[] {
	return [getProgressTitle(progress.stage), buildAsciiProgressBar(progress), progress.message];
}

function getProgressTitle(stage: "discover" | "chunk" | "persist" | "embed" | "done"): string {
	switch (stage) {
		case "embed":
			return "Embedding semantic chunks";
		case "persist":
			return "Persisting semantic chunks";
		case "done":
			return "Semantic index build complete";
		default:
			return "Semantic index build";
	}
}

function buildAsciiProgressBar(progress: {
	stage: "discover" | "chunk" | "persist" | "embed" | "done";
	message: string;
	filesDiscovered?: number;
	filesProcessed?: number;
	filesIndexed?: number;
	embeddingsUpdated?: number;
	embeddingsTotal?: number;
}): string {
	const counts =
		progress.stage === "embed"
			? [progress.embeddingsUpdated, progress.embeddingsTotal]
			: progress.stage === "persist"
				? [progress.filesIndexed, progress.filesDiscovered]
				: [progress.filesProcessed, progress.filesDiscovered];
	const [current, total] = counts;
	if (!current || !total || total <= 0) {
		return "[working…]";
	}
	const width = 24;
	const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
	return `[${"=".repeat(filled)}${" ".repeat(width - filled)}] ${current}/${total}`;
}

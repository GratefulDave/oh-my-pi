import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { chunkFile } from "../../../.omp/extensions/semantic-search/chunker";
import { formatSearchResponse, parseSearchCommandArgs } from "../../../.omp/extensions/semantic-search/commands";
import { embedText, embedTexts, resolveEmbeddingConfig } from "../../../.omp/extensions/semantic-search/embeddings";
import semanticSearchExtension from "../../../.omp/extensions/semantic-search/index";
import {
	assertWithinCwd,
	getSemanticSearchDbPath,
	getSemanticSearchDir,
} from "../../../.omp/extensions/semantic-search/paths";
import { renderSemanticSearchMessage } from "../../../.omp/extensions/semantic-search/renderers";
import { decomposeQuery, SemanticSearchService } from "../../../.omp/extensions/semantic-search/service";

describe("local semantic search extension", () => {
	let tempDir: TempDir;
	let projectDir: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@semantic-search-");
		projectDir = tempDir.path();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("keeps semantic index paths strictly inside cwd", () => {
		expect(getSemanticSearchDir(projectDir)).toBe(path.join(projectDir, ".omp", "semantic-search"));
		expect(getSemanticSearchDbPath(projectDir)).toBe(path.join(projectDir, ".omp", "semantic-search", "index.db"));
		expect(() => assertWithinCwd(projectDir, path.join(projectDir, "..", "escape.db"))).toThrow(
			"Refusing to access path outside cwd",
		);
	});

	it("extracts AST-aware chunks for functions and class methods", () => {
		const source = [
			"export function loadSettings(input: string) {",
			"\treturn input.trim();",
			"}",
			"",
			"export class ConfigLoader {",
			"\tloadFile(path: string) {",
			"\t\treturn path.length;",
			"\t}",
			"}",
		].join("\n");
		const chunks = chunkFile("src/config.ts", source, "file-hash");
		expect(chunks.some(chunk => chunk.symbol === "loadSettings" && chunk.kind === "function")).toBe(true);
		expect(chunks.some(chunk => chunk.symbol === "ConfigLoader.loadFile" && chunk.kind === "method")).toBe(true);
	});

	it("decomposes only long compound queries", () => {
		expect(decomposeQuery("find auth middleware")).toEqual(["find auth middleware"]);
		expect(
			decomposeQuery("find auth middleware and session bootstrap, then locate config loading for retries"),
		).toEqual([
			"find auth middleware and session bootstrap, then locate config loading for retries",
			"find auth middleware",
			"session bootstrap",
			"locate config loading for retries",
		]);
	});

	it("uses the personal embedding defaults unless overridden", () => {
		expect(resolveEmbeddingConfig()).toEqual({
			model: "snowflake-arctic-embed-l-v2.0-bf16",
			baseUrl: "http://127.0.0.1:18790",
		});
		expect(resolveEmbeddingConfig("custom-model", "http://127.0.0.1:9999/")).toEqual({
			model: "custom-model",
			baseUrl: "http://127.0.0.1:9999",
		});
	});

	it("prefers the openai-compatible embeddings route when available", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch);
		const result = await embedText("search me", "embed-model", "http://127.0.0.1:18790");
		expect(result.vector).toEqual([0.25, 0.5, 0.75]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [requestUrl, requestInit] = fetchSpy.mock.calls[0] ?? [];
		expect(requestUrl).toBe("http://127.0.0.1:18790/v1/embeddings");
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			model: "embed-model",
			input: "search me",
			encoding_format: "float",
		});
	});

	it("falls back to the ollama embeddings route when the openai-compatible route fails", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("missing", { status: 404, statusText: "Not Found" }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embedding: [0.1, 0.2] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const result = await embedText("fallback", "embed-model", "http://127.0.0.1:18790");
		expect(result.vector).toEqual([0.1, 0.2]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:18790/v1/embeddings");
		expect(fetchSpy.mock.calls[1]?.[0]).toBe("http://127.0.0.1:18790/api/embeddings");
		expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
			model: "embed-model",
			prompt: "fallback",
		});
	});

	it("batches openai-compatible embedding requests", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(
				JSON.stringify({
					data: [
						{ embedding: [0.1, 0.2], index: 0 },
						{ embedding: [0.3, 0.4], index: 1 },
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch);
		const result = await embedTexts(
			["first semantic chunk", "second semantic chunk"],
			"embed-model",
			"http://127.0.0.1:18790",
		);
		expect(result.vectors).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
			model: "embed-model",
			input: ["first semantic chunk", "second semantic chunk"],
			encoding_format: "float",
		});
	});

	it("enables rerank by default and allows opting out", () => {
		expect(parseSearchCommandArgs("find settings")).toMatchObject({
			query: "find settings",
			rerank: true,
			decompose: true,
		});
		expect(parseSearchCommandArgs("find settings --no-rerank")).toMatchObject({
			query: "find settings",
			rerank: false,
		});
	});

	it("builds and searches a cwd-local index", async () => {
		const sourceDir = path.join(projectDir, "src");
		await fs.mkdir(sourceDir, { recursive: true });
		await Bun.write(
			path.join(sourceDir, "settings.ts"),
			[
				"export function loadSettingsFile(input: string) {",
				"\tconst normalized = input.trim();",
				"\treturn normalized.toUpperCase();",
				"}",
			].join("\n"),
		);
		await Bun.write(
			path.join(sourceDir, "auth.ts"),
			[
				"export async function ensureAuthSession(userId: string) {",
				String.raw`\treturn \`session:\${userId}\`;`,
				"}",
			].join("\n"),
		);

		const progress: string[] = [];
		const service = new SemanticSearchService();
		const stats = await service.buildIndex(projectDir, {
			concurrency: 2,
			onProgress(update) {
				progress.push(update.message);
			},
		});
		const response = await service.search(projectDir, "load settings file", {
			limit: 3,
			decompose: true,
			rerank: false,
		});
		const dbPath = getSemanticSearchDbPath(projectDir);
		const parentDbPath = path.join(path.dirname(projectDir), ".omp", "semantic-search", "index.db");
		expect(progress.some(message => message.startsWith("Discovered "))).toBe(true);
		expect(progress.some(message => message.startsWith("Finished semantic index build"))).toBe(true);
		expect(stats.filesIndexed).toBeGreaterThan(0);
		expect(await Bun.file(dbPath).exists()).toBe(true);
		expect(await Bun.file(parentDbPath).exists()).toBe(false);
		expect(response.results[0]?.path).toBe("src/settings.ts");
		expect(response.results[0]?.symbol).toBe("loadSettingsFile");
	});

	it("reclaims stale semantic index build locks", async () => {
		const lockDir = path.join(projectDir, ".omp", "semantic-search");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(path.join(lockDir, "build.lock"), JSON.stringify({ pid: 99999, startedAt: 1, cwd: projectDir }));
		const service = new SemanticSearchService();
		const stats = await service.buildIndex(projectDir, { concurrency: 1 });
		expect(stats.filesDiscovered).toBe(0);
		expect(await Bun.file(path.join(lockDir, "build.lock")).exists()).toBe(false);
	});

	it("rejects active semantic index build locks with a clear error", async () => {
		const lockDir = path.join(projectDir, ".omp", "semantic-search");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "build.lock"),
			JSON.stringify({ pid: process.pid, startedAt: Date.now(), cwd: projectDir }),
		);
		const service = new SemanticSearchService();
		await expect(service.buildIndex(projectDir, { concurrency: 1 })).rejects.toThrow(
			"Semantic index build already running.",
		);
	});

	it("excludes virtualenvs worktrees and internal generated directories from discovery", async () => {
		await fs.mkdir(path.join(projectDir, "backend", ".venv", "lib"), { recursive: true });
		await fs.mkdir(path.join(projectDir, ".claude", "worktrees", "agent-1", "src"), { recursive: true });
		await fs.mkdir(path.join(projectDir, ".codex", "skills"), { recursive: true });
		await fs.mkdir(path.join(projectDir, ".cursor", "cache"), { recursive: true });
		await fs.mkdir(path.join(projectDir, ".zed", "cache"), { recursive: true });
		await fs.mkdir(path.join(projectDir, ".idea"), { recursive: true });
		await fs.mkdir(path.join(projectDir, "src", "__generated__"), { recursive: true });
		await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
		await Bun.write(path.join(projectDir, "backend", ".venv", "lib", "skip.py"), "def skip():\n    return 1\n");
		await Bun.write(
			path.join(projectDir, ".claude", "worktrees", "agent-1", "src", "skip.ts"),
			"export const skip = true;\n",
		);
		await Bun.write(path.join(projectDir, ".codex", "skills", "skip.md"), "# skip\n");
		await Bun.write(path.join(projectDir, ".cursor", "cache", "skip.ts"), "export const skip = true;\n");
		await Bun.write(path.join(projectDir, ".zed", "cache", "skip.ts"), "export const skip = true;\n");
		await Bun.write(path.join(projectDir, ".idea", "workspace.xml"), "<xml />\n");
		await Bun.write(path.join(projectDir, "src", "__generated__", "skip.ts"), "export const skip = true;\n");
		await Bun.write(path.join(projectDir, "src", "api.gen.ts"), "export const skip = true;\n");
		await Bun.write(path.join(projectDir, "src", "keep.ts"), "export const keep = true;\n");
		const service = new SemanticSearchService();
		const stats = await service.buildIndex(projectDir, { concurrency: 1 });
		const response = await service.search(projectDir, "keep", { limit: 5, rerank: false, decompose: false });
		expect(stats.filesDiscovered).toBe(1);
		expect(stats.filesIndexed).toBe(1);
		expect(response.results.map(result => result.path)).toEqual(["src/keep.ts"]);
	});

	it("batches embedding backfill during index builds", async () => {
		const sourceDir = path.join(projectDir, "src");
		await fs.mkdir(sourceDir, { recursive: true });
		await Bun.write(
			path.join(sourceDir, "one.ts"),
			["export function alphaSetting() {", "\treturn 1;", "}"].join("\n"),
		);
		await Bun.write(
			path.join(sourceDir, "two.ts"),
			["export function betaSetting() {", "\treturn 2;", "}"].join("\n"),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(
				JSON.stringify({
					data: [
						{ embedding: [0.1, 0.2], index: 0 },
						{ embedding: [0.3, 0.4], index: 1 },
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch);
		const service = new SemanticSearchService();
		const stats = await service.buildIndex(projectDir, {
			concurrency: 2,
			computeEmbeddings: true,
			embeddingModel: "embed-model",
			embeddingBaseUrl: "http://127.0.0.1:18790",
		});
		expect(stats.embeddingsUpdated).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
			model: "embed-model",
			input: expect.any(Array),
			encoding_format: "float",
		});
	});

	it("falls back to embedding-only retrieval for natural-language queries", async () => {
		const sourceDir = path.join(projectDir, "src");
		await fs.mkdir(sourceDir, { recursive: true });
		await Bun.write(
			path.join(sourceDir, "signals.ts"),
			["export function buildLeadSignalRollup() {", "\treturn 42;", "}"].join("\n"),
		);
		await Bun.write(
			path.join(sourceDir, "billing.ts"),
			["export function invoiceSettlementLedger() {", "\treturn 7;", "}"].join("\n"),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (...args: Parameters<typeof fetch>) => {
			const body = JSON.parse(String(args[1]?.body));
			const inputs = Array.isArray(body.input) ? body.input : [body.input];
			const data = inputs.map((input: string, index: number) => {
				if (input.includes("ads intelligence")) {
					return { embedding: [1, 0], index };
				}
				if (input.includes("buildLeadSignalRollup")) {
					return { embedding: [1, 0], index };
				}
				return { embedding: [0, 1], index };
			});
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch);
		const service = new SemanticSearchService();
		await service.buildIndex(projectDir, {
			concurrency: 2,
			computeEmbeddings: true,
			embeddingModel: "embed-model",
			embeddingBaseUrl: "http://127.0.0.1:18790",
		});
		const response = await service.search(projectDir, "where is the code to calculate ads intelligence?", {
			limit: 3,
			embeddingModel: "embed-model",
			embeddingBaseUrl: "http://127.0.0.1:18790",
		});
		expect(fetchSpy).toHaveBeenCalled();
		expect(response.reranked).toBe(true);
		expect(response.results[0]?.path).toBe("src/signals.ts");
		expect(response.results[0]?.symbol).toBe("buildLeadSignalRollup");
	});

	it("reranks by default and reports embedding usage in output", async () => {
		const sourceDir = path.join(projectDir, "src");
		await fs.mkdir(sourceDir, { recursive: true });
		await Bun.write(
			path.join(sourceDir, "settings.ts"),
			[
				"export function loadSettingsFile(input: string) {",
				"\tconst normalized = input.trim();",
				"\treturn normalized.toUpperCase();",
				"}",
			].join("\n"),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (..._args: Parameters<typeof fetch>) => {
			return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);
		const service = new SemanticSearchService();
		await service.buildIndex(projectDir, { concurrency: 2 });
		const response = await service.search(projectDir, "load settings file", {
			limit: 3,
			decompose: true,
		});
		expect(fetchSpy).toHaveBeenCalled();
		expect(response.reranked).toBe(true);
		expect(response.rerankInfo).toEqual({
			model: "snowflake-arctic-embed-l-v2.0-bf16",
			baseUrl: "http://127.0.0.1:18790",
		});
		expect(formatSearchResponse(response)).toContain(
			"reranked: embeddings (snowflake-arctic-embed-l-v2.0-bf16 @ http://127.0.0.1:18790)",
		);
	});

	it("renders semantic search results collapsed until expanded", () => {
		const uiTheme = {
			bg(_name: string, text: string) {
				return text;
			},
			fg(_name: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		};
		const content = [
			"Semantic search results for: where is ads intelligence code?",
			"reranked: embeddings (snowflake-arctic-embed-l-v2.0-bf16 @ http://127.0.0.1:18790)",
			"",
			"1. src/lib/analysis/hourly.ts:1-10 • buildEditorialIntelligence",
			"   kind=function score=18.00 embedding=0.900",
			"   export function buildEditorialIntelligence() {}",
		].join("\n");
		const collapsed = Bun.stripANSI(
			renderSemanticSearchMessage({ customType: "semantic-search-results", content }, { expanded: false }, uiTheme)
				.render(120)
				.join("\n"),
		);
		expect(collapsed).toContain("[semantic-search-results]");
		expect(collapsed).toContain("ctrl+o to expand");
		expect(collapsed).not.toContain("export function buildEditorialIntelligence() {}");
		const expanded = Bun.stripANSI(
			renderSemanticSearchMessage({ customType: "semantic-search-results", content }, { expanded: true }, uiTheme)
				.render(120)
				.join("\n"),
		);
		expect(expanded).toContain("export function buildEditorialIntelligence() {}");
	});

	it("registers the repo-local commands and tool", async () => {
		const tools = new Map<string, unknown>();
		const commands = new Map<string, unknown>();
		const renderers = new Map<string, unknown>();
		const sentMessages: Array<{
			customType: string;
			content: string;
			details?: unknown;
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
		}> = [];
		semanticSearchExtension({
			zod: await import("zod/v4"),
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand(name, options) {
				commands.set(name, options);
			},
			registerMessageRenderer(customType, renderer) {
				renderers.set(customType, renderer);
			},
			sendMessage(message, options) {
				sentMessages.push({ ...message, options });
			},
			setLabel() {},
			logger: { error() {} },
		});
		expect(tools.has("local_semantic_search")).toBe(true);
		expect(commands.has("semantic-index")).toBe(true);
		expect(commands.has("semantic-search")).toBe(true);
		expect(commands.has("semantic-status")).toBe(true);
		expect(renderers.has("semantic-search-results")).toBe(true);

		const buildIndexSpy = vi
			.spyOn(SemanticSearchService.prototype, "buildIndex")
			.mockImplementation(async (_cwd, options) => {
				const onProgress = options?.onProgress;
				onProgress?.({ stage: "discover", message: "Discovered 500 candidate files", filesDiscovered: 500 });
				onProgress?.({
					stage: "chunk",
					filesDiscovered: 500,
					filesProcessed: 250,
					message: "Scanned 250/500 files",
				});
				onProgress?.({
					stage: "persist",
					filesDiscovered: 500,
					filesIndexed: 100,
					message: "Indexed 100/500 files (1200 chunks)",
				});
				onProgress?.({
					stage: "embed",
					embeddingsUpdated: 100,
					embeddingsTotal: 200,
					message: "Embedded 100/200 semantic chunks",
				});
				onProgress?.({
					stage: "done",
					filesDiscovered: 500,
					message: "Finished semantic index build: 100 indexed, 10 skipped, 1200 chunks",
				});
				return {
					cwd: projectDir,
					dbPath: path.join(projectDir, ".omp", "semantic-search", "index.db"),
					filesDiscovered: 500,
					filesIndexed: 100,
					filesSkipped: 10,
					filesRemoved: 0,
					chunksUpserted: 1200,
					embeddingsUpdated: 100,
				};
			});
		const semanticIndexCommand = commands.get("semantic-index") as {
			handler: (
				args: string,
				ctx: {
					cwd: string;
					ui: {
						notify(message: string, type?: "info" | "warning" | "error"): void;
						setStatus?(key: string, text: string | undefined): void;
						setWorkingMessage?(message?: string): void;
						setWidget?(
							key: string,
							content: string[] | undefined,
							options?: { placement?: "aboveEditor" | "belowEditor" },
						): void;
					};
				},
			) => Promise<void>;
		};
		const statuses: Array<string | undefined> = [];
		const widgets: Array<string[] | undefined> = [];
		await semanticIndexCommand.handler("rebuild --embeddings", {
			cwd: projectDir,
			ui: {
				notify() {},
				setStatus(_key, text) {
					statuses.push(text);
				},
				setWorkingMessage() {},
				setWidget(_key, content) {
					widgets.push(content);
				},
			},
		});
		expect(buildIndexSpy).toHaveBeenCalled();
		expect(statuses).toContain("Starting semantic index build...");
		expect(statuses).toContain("Scanned 250/500 files");
		expect(widgets.some(widget => widget?.includes("Semantic index build"))).toBe(true);
		expect(widgets.some(widget => widget?.includes("Embedding semantic chunks"))).toBe(true);
		expect(widgets.some(widget => widget?.some(line => line.includes("100/200")))).toBe(true);
		expect(sentMessages.map(message => message.content)).not.toContain("Starting semantic index build...");
		expect(sentMessages.map(message => message.content)).not.toContain("Scanned 250/500 files");
		expect(
			sentMessages.some(message =>
				message.content.includes(path.join(projectDir, ".omp", "semantic-search", "index.db")),
			),
		).toBe(true);

		const searchSpy = vi.spyOn(SemanticSearchService.prototype, "search").mockResolvedValue({
			query: "where is the code to calculate ads intelligence?",
			queries: ["where is the code to calculate ads intelligence?"],
			reranked: true,
			rerankInfo: {
				model: "snowflake-arctic-embed-l-v2.0-bf16",
				baseUrl: "http://127.0.0.1:18790",
			},
			results: [
				{
					chunkId: "src/lib/analysis/hourly.ts:1-10:test",
					path: "src/lib/analysis/hourly.ts",
					language: "typescript",
					kind: "function",
					symbol: "buildEditorialIntelligence",
					startLine: 1,
					endLine: 10,
					content: "export function buildEditorialIntelligence() {}",
					ftsScore: 0,
					heuristicScore: 0,
					embeddingScore: 0.9,
					finalScore: 18,
					matchedQuery: "where is the code to calculate ads intelligence?",
				},
			],
		});
		const semanticSearchCommand = commands.get("semantic-search") as {
			handler: (
				args: string,
				ctx: {
					cwd: string;
					ui: {
						notify(message: string, type?: "info" | "warning" | "error"): void;
						setStatus?(key: string, text: string | undefined): void;
						setWorkingMessage?(message?: string): void;
					};
				},
			) => Promise<void>;
		};
		await semanticSearchCommand.handler("where is the code to calculate ads intelligence?", {
			cwd: projectDir,
			ui: { notify() {} },
		});
		expect(searchSpy).toHaveBeenCalled();
		const semanticSearchMessage = sentMessages.find(message => message.customType === "semantic-search-results");
		expect(semanticSearchMessage?.options).toEqual({ triggerTurn: true });
		expect(semanticSearchMessage?.content).toContain("buildEditorialIntelligence");
	});
});

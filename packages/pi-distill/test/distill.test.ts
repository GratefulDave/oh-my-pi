import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as YAML from "yaml";
import { byteLength, DEFAULTS } from "../src/compress";
import type { DistillConfig } from "../src/config";
import { type DistillContext, type DistillRuntimeState, processToolResult } from "../src/index";
import { aggregate, resetStatsForTests } from "../src/stats";

const tempDirs: string[] = [];

const baseConfig: DistillConfig = {
	minBytes: 1,
	arrayHead: 2,
	arrayTail: 1,
	scalarMax: 12,
	builtinSkip: new Set(),
	verbatimTools: new Set(),
};

const opts = {
	arrayHead: baseConfig.arrayHead,
	arrayTail: baseConfig.arrayTail,
	scalarMax: baseConfig.scalarMax,
};

afterEach(async () => {
	resetStatsForTests();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-distill-test-"));
	tempDirs.push(dir);
	return dir;
}

function originalJson(): string {
	return JSON.stringify(
		{
			message: "x".repeat(80),
			items: Array.from({ length: 12 }, (_, index) => ({ index, value: "value".repeat(8) })),
		},
		null,
		2,
	);
}

function fakeContext(options: { saveFails?: boolean; artifactPathMissing?: boolean } = {}): DistillContext {
	const artifacts = new Map<string, string>();
	return {
		sessionManager: {
			getArtifactsDir: () => "/tmp/pi-distill-artifacts",
			getSessionId: () => "test-session",
			getCwd: () => process.cwd(),
			saveArtifact: async content => {
				if (options.saveFails) return undefined;
				artifacts.set("0", content);
				return "0";
			},
			getArtifactPath: async id =>
				options.artifactPathMissing || !artifacts.has(id) ? null : `/tmp/pi-distill-artifacts/${id}.txt`,
		},
	};
}

async function distillText(text: string, context: DistillContext = fakeContext(), cfg: DistillConfig = baseConfig) {
	const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
	const result = await processToolResult(
		{
			toolName: "custom_tool",
			content: [{ type: "text", text }],
			details: undefined,
			isError: false,
		},
		context,
		cfg,
		opts,
		state,
	);
	return { result, state };
}

describe("pi-distill structured compression", () => {
	test("truncates long JSON strings while preserving valid JSON metadata", async () => {
		const { result } = await distillText(originalJson());
		expect(result).toBeDefined();
		const parsed = JSON.parse(result?.content[0]?.type === "text" ? result.content[0].text : "");
		expect(parsed.__pi_distill.artifact).toBe("artifact://0");
		expect(parsed.__pi_distill.elided).toBeGreaterThan(0);
		expect(parsed.data.message).toContain("…(+");
	});

	test("elides large JSON arrays with head and tail values", async () => {
		const text = JSON.stringify(
			Array.from({ length: 8 }, (_, index) => ({ index, value: "x".repeat(40) })),
			null,
			2,
		);
		const { result } = await distillText(text);
		const parsed = JSON.parse(result?.content[0]?.type === "text" ? result.content[0].text : "");
		expect(parsed.data).toHaveLength(4);
		expect(parsed.data[0].index).toBe(0);
		expect(parsed.data[2]).toBe("…(+5 items elided)");
		expect(parsed.data[3].index).toBe(7);
	});

	test("compresses YAML objects and lists as parseable YAML", async () => {
		const yaml = YAML.stringify({
			name: "example",
			items: Array.from({ length: 9 }, (_, index) => ({ index, text: "abcdef".repeat(8) })),
		});
		const { result } = await distillText(yaml);
		const parsed = YAML.parse(result?.content[0]?.type === "text" ? result.content[0].text : "");
		expect(parsed.__pi_distill.artifact).toBe("artifact://0");
		expect(parsed.data.items[2]).toBe("…(+6 items elided)");
	});

	test("extracts fenced JSON and YAML payloads", async () => {
		const jsonResult = await distillText(`\`\`\`json\n${originalJson()}\n\`\`\``);
		const yamlResult = await distillText(
			`\`\`\`yaml\n${YAML.stringify({ values: Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(40)}`) })}\n\`\`\``,
		);
		expect(
			JSON.parse(jsonResult.result?.content[0]?.type === "text" ? jsonResult.result.content[0].text : "")
				.__pi_distill.artifact,
		).toBe("artifact://0");
		expect(
			YAML.parse(yamlResult.result?.content[0]?.type === "text" ? yamlResult.result.content[0].text : "")
				.__pi_distill.artifact,
		).toBe("artifact://0");
	});

	test("compresses MCP rawContent resources before flattened resource prefixes", async () => {
		const raw = originalJson();
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "mcp__docs_read",
				content: [{ type: "text", text: `[Resource: file:///large.json]\n${raw}` }],
				details: {
					serverName: "docs",
					mcpToolName: "read",
					rawContent: [{ type: "resource", resource: { uri: "file:///large.json", text: raw } }],
				},
				isError: false,
			},
			fakeContext(),
			baseConfig,
			opts,
			state,
		);
		expect(result).toBeDefined();
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.startsWith("[Resource:")).toBe(false);
		expect(JSON.parse(text).__pi_distill.artifact).toBe("artifact://0");
	});
	test("compresses MCP rendered output when rawContent is absent", async () => {
		const rendered = Array.from(
			{ length: 90 },
			(_, index) => `${index + 1}: MCP rendered line ${"x".repeat(100)}`,
		).join("\n");
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "mcp__context7__get_library_docs",
				content: [{ type: "text", text: rendered }],
				details: {
					serverName: "context7",
					mcpToolName: "get_library_docs",
					displayContent: rendered,
				},
				isError: false,
			},
			fakeContext(),
			baseConfig,
			opts,
			state,
		);
		const replacement = result?.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(replacement);
		expect(parsed.__pi_distill.artifact).toBe("artifact://0");
		expect(parsed.__pi_distill.recover).toContain("Read artifact://0");
		expect(parsed.data.tool).toContain("mcp__context");
		expect(parsed.data.lines).toContain("…(+87 items elided)");
		expect((result?.details as { displayContent?: string } | undefined)?.displayContent).toBe(replacement);
		expect(state.hits).toBe(1);
	});

	test("passes through when artifact save or resolution fails", async () => {
		const saveFailed = await distillText(originalJson(), fakeContext({ saveFails: true }));
		const resolveFailed = await distillText(originalJson(), fakeContext({ artifactPathMissing: true }));
		expect(saveFailed.result).toBeUndefined();
		expect(saveFailed.state.hits).toBe(0);
		expect(resolveFailed.result).toBeUndefined();
		expect(resolveFailed.state.hits).toBe(0);
	});

	test("passes through when wrapped output is not smaller", async () => {
		const cfg = { ...baseConfig, scalarMax: DEFAULTS.scalarMax };
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const text = JSON.stringify({ value: "abcdefghijklmnop" }, null, 2);
		const result = await processToolResult(
			{ toolName: "custom_tool", content: [{ type: "text", text }], details: undefined, isError: false },
			fakeContext(),
			cfg,
			{ arrayHead: cfg.arrayHead, arrayTail: cfg.arrayTail, scalarMax: cfg.scalarMax },
			state,
		);
		expect(result).toBeUndefined();
		expect(state.savedBytes).toBe(0);
	});

	test("records saved bytes after metadata is included", async () => {
		const text = originalJson();
		const { result, state } = await distillText(text);
		const replacement = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(state.hits).toBe(1);
		expect(state.savedBytes).toBe(byteLength(text) - byteLength(replacement));
	});

	test("aggregates reduction percent from recorded original bytes", async () => {
		const text = originalJson();
		const context = fakeContext();
		const { result } = await distillText(text, context);
		const replacement = result?.content[0]?.type === "text" ? result.content[0].text : "";
		const stats = aggregate(context);
		const expectedReduction = ((byteLength(text) - byteLength(replacement)) / byteLength(text)) * 100;
		expect(stats.project.originalBytes).toBe(byteLength(text));
		expect(stats.project.replacementBytes).toBe(byteLength(replacement));
		expect(stats.project.knownSavedBytes).toBe(byteLength(text) - byteLength(replacement));
		expect(stats.project.reductionPercent).toBeCloseTo(expectedReduction, 6);
	});

	test("compresses unstructured AST grep output and updates displayContent", async () => {
		const text = [
			"packages/example/src/a.ts#ABCD",
			...Array.from(
				{ length: 120 },
				(_, index) => `${index + 1}: function fn${index}() { return "${"x".repeat(60)}"; }`,
			),
			"",
			"Result limit reached; narrow paths or increase limit.",
			"Parse issues: 20 / 37",
		].join("\n");
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "ast_grep",
				content: [{ type: "text", text }],
				details: {
					matchCount: 9384,
					fileCount: 1488,
					filesSearched: 1488,
					limitReached: true,
					displayContent: text,
				},
				isError: false,
			},
			fakeContext(),
			baseConfig,
			opts,
			state,
		);
		const replacement = result?.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(replacement);
		expect(parsed.__pi_distill.artifact).toBe("artifact://0");
		expect(parsed.__pi_distill.recover).toContain("Read artifact://0");
		expect(parsed.data.tool).toBe("ast_grep");
		expect(parsed.data.lines).toContain("…(+121 items elided)");
		expect((result?.details as { displayContent?: string } | undefined)?.displayContent).toBe(replacement);
		expect(state.savedBytes).toBe(byteLength(text) - byteLength(replacement));
	});

	test("compresses AST grep displayContent after generic artifact spill metadata", async () => {
		const displayContent = Array.from(
			{ length: 80 },
			(_, index) => `${index + 1}: function fn${index}() { return "${"x".repeat(120)}"; }`,
		).join("\n");
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "ast_grep",
				content: [{ type: "text", text: displayContent.slice(0, 2000) }],
				details: {
					displayContent,
					meta: { truncation: { artifactId: "spill-0" } },
				},
				isError: false,
			},
			fakeContext(),
			baseConfig,
			opts,
			state,
		);
		const replacement = result?.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(replacement);
		expect(parsed.__pi_distill.artifact).toBe("artifact://0");
		expect(parsed.__pi_distill.originalBytes).toBe(byteLength(displayContent));
		expect(parsed.data.lines).toContain("…(+77 items elided)");
		expect((result?.details as { displayContent?: string } | undefined)?.displayContent).toBe(replacement);
		expect(
			(result?.details as { meta?: { truncation?: { artifactId?: string } } } | undefined)?.meta?.truncation
				?.artifactId,
		).toBe("spill-0");
		expect(state.hits).toBe(1);
	});

	test("compresses AST grep even when output is below the generic threshold", async () => {
		const text = Array.from(
			{ length: 34 },
			(_, index) => `${index + 1}: function fn${index}() { return "${"x".repeat(54)}"; }`,
		).join("\n");
		const cfg = { ...baseConfig, minBytes: 4096 };
		expect(byteLength(text)).toBeLessThan(cfg.minBytes);
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "ast_grep",
				content: [{ type: "text", text: "AST Grep summary line" }],
				details: { displayContent: text },
				isError: false,
			},
			fakeContext(),
			cfg,
			opts,
			state,
		);
		const replacement = result?.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(replacement);
		expect(parsed.__pi_distill.artifact).toBe("artifact://0");
		expect(parsed.__pi_distill.originalBytes).toBe(byteLength(text));
		expect(parsed.data.lines).toContain("…(+31 items elided)");
		expect((result?.details as { displayContent?: string } | undefined)?.displayContent).toBe(replacement);
		expect(state.hits).toBe(1);
	});

	test("does not redistill an existing pi-distill wrapper", async () => {
		const alreadyDistilled = JSON.stringify(
			{
				__pi_distill: {
					artifact: "artifact://existing",
					elided: 10,
					originalBytes: 50_000,
					recover: "Read artifact://existing",
				},
				data: {
					items: Array.from({ length: 80 }, (_, index) => ({ index, text: "x".repeat(80) })),
				},
			},
			null,
			2,
		);
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "read",
				content: [{ type: "text", text: alreadyDistilled }],
				details: { displayContent: alreadyDistilled },
				isError: false,
			},
			fakeContext(),
			{ ...baseConfig, builtinSkip: new Set() },
			opts,
			state,
		);
		expect(result).toBeUndefined();
		expect(state.hits).toBe(0);
	});

	test("writes recoverable artifacts with a file-backed SessionManager", async () => {
		const cwd = await tempDir();
		const sessionDir = path.join(cwd, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const original = originalJson();
		const state: DistillRuntimeState = { savedBytes: 0, hits: 0 };
		const result = await processToolResult(
			{
				toolName: "mcp__server_tool",
				content: [{ type: "text", text: `[Resource: mem://large]\n${original}` }],
				details: {
					serverName: "server",
					mcpToolName: "tool",
					rawContent: [{ type: "resource", resource: { uri: "mem://large", text: original } }],
				},
				isError: false,
			},
			{ sessionManager },
			baseConfig,
			opts,
			state,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(text);
		const artifactId = String(parsed.__pi_distill.artifact).slice("artifact://".length);
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		expect(artifactPath).toBeString();
		expect(await Bun.file(artifactPath ?? "").text()).toBe(`[Resource: mem://large]\n${original}`);
	});
});

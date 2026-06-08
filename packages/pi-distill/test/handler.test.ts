/** End-to-end handler smoke test with mocked pi/ctx. Run: `bun test`. */
import { expect, test } from "bun:test";

import piDistill from "../src/index";

type Handler = (event: any, ctx: any) => Promise<{ content: any[] } | undefined>;

function setup() {
	const commands: Record<string, Function> = {};
	let toolResult: Handler | undefined;
	const saved: { text: string; type: string }[] = [];

	const pi: any = {
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts.handler;
		},
		on: (event: string, handler: Handler) => {
			if (event === "tool_result") toolResult = handler;
		},
	};
	piDistill(pi);

	const ctx: any = {
		ui: { notify: () => {} },
		sessionManager: {
			saveArtifact: async (text: string, type: string) => {
				saved.push({ text, type });
				return `art_${saved.length}`;
			},
		},
	};
	return { commands, toolResult: toolResult!, ctx, saved };
}

const bigJson = () =>
	JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ id: i, v: "x".repeat(40) })) }, null, 2);

test("compresses large MCP json, spills full original, footers artifact", async () => {
	const { toolResult, ctx, saved } = setup();
	const original = bigJson();
	const res = await toolResult(
		{ toolName: "some_mcp_tool", isError: false, details: { rawContent: [] }, content: [{ type: "text", text: original }] },
		ctx,
	);
	expect(res).toBeDefined();
	const text = res!.content[0].text as string;
	expect(text).toContain("artifact://art_1");
	expect(text).toContain("nodes elided");
	// full original spilled verbatim
	expect(saved[0].text).toBe(original);
	expect(saved[0].type).toBe("pi-distill");
	// compact body (before footer) still valid JSON
	const body = text.slice(0, text.indexOf("\n\n[pi-distill:"));
	expect(() => JSON.parse(body)).not.toThrow();
});

test("skips builtin tools (native spill owns them)", async () => {
	const { toolResult, ctx, saved } = setup();
	const res = await toolResult(
		{ toolName: "read", isError: false, details: undefined, content: [{ type: "text", text: bigJson() }] },
		ctx,
	);
	expect(res).toBeUndefined();
	expect(saved.length).toBe(0);
});

test("skips results already natively spilled (artifactId present)", async () => {
	const { toolResult, ctx } = setup();
	const res = await toolResult(
		{
			toolName: "mcp_tool",
			isError: false,
			details: { meta: { truncation: { artifactId: "native_1" } } },
			content: [{ type: "text", text: bigJson() }],
		},
		ctx,
	);
	expect(res).toBeUndefined();
});

test("fail-safe: when saveArtifact throws, part passes through uncompressed", async () => {
	const { toolResult, ctx } = setup();
	ctx.sessionManager.saveArtifact = async () => {
		throw new Error("no session");
	};
	const original = bigJson();
	const res = await toolResult(
		{ toolName: "mcp_tool", isError: false, details: {}, content: [{ type: "text", text: original }] },
		ctx,
	);
	expect(res).toBeUndefined(); // nothing changed → raw stays
});

test("error results are ignored", async () => {
	const { toolResult, ctx } = setup();
	const res = await toolResult(
		{ toolName: "mcp_tool", isError: true, details: {}, content: [{ type: "text", text: bigJson() }] },
		ctx,
	);
	expect(res).toBeUndefined();
});

test("small payload passes through", async () => {
	const { toolResult, ctx, saved } = setup();
	const res = await toolResult(
		{ toolName: "mcp_tool", isError: false, details: {}, content: [{ type: "text", text: '{"a":1}' }] },
		ctx,
	);
	expect(res).toBeUndefined();
	expect(saved.length).toBe(0);
});

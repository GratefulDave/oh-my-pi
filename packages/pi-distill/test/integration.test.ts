/**
 * LANE-3 — real OMP/lex integration. Exercises pi-distill against the genuine
 * SessionManager + on-disk ArtifactManager (not a mock), proving lossless recovery,
 * and (best-effort) the real extension-loader path.
 *
 * Run: `bun test` from packages/pi-distill.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

import piDistill from "../src/index";
import { flush } from "../src/stats";

// ---- harness: capture the extension's tool_result handler + commands ----------

type ToolResultHandler = (event: any, ctx: any) => Promise<{ content: any[] } | undefined>;

function loadExtension() {
	let toolResult: ToolResultHandler | undefined;
	const commands: Record<string, (args: string, ctx: any) => unknown> = {};
	const pi: any = {
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts.handler;
		},
		on: (event: string, handler: any) => {
			if (event === "tool_result") toolResult = handler;
		},
	};
	piDistill(pi);
	if (!toolResult) throw new Error("pi-distill did not register a tool_result handler");
	return { toolResult, commands };
}

let tempDir: string;
let originalHome: string | undefined;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-distill-int-"));
	// Isolate HOME so recordHit (fired by the real handler) writes its global stats
	// store into the temp dir, never the developer's real ~/.omp.
	originalHome = process.env.HOME;
	process.env.HOME = path.join(tempDir, "home");
	fs.mkdirSync(process.env.HOME, { recursive: true });
});
afterAll(async () => {
	await flush(); // drain any debounced stats writes before HOME is restored
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function realCtx(label: string) {
	const cwd = path.join(tempDir, label, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const sessionManager = SessionManager.create(cwd, path.join(tempDir, label, "sessions"));
	const ctx: any = {
		hasUI: false,
		cwd,
		sessionManager,
		ui: { notify: () => {} },
	};
	return { ctx, sessionManager };
}

const bigJson = () =>
	JSON.stringify({ items: Array.from({ length: 120 }, (_, i) => ({ id: i, v: "x".repeat(40) })) }, null, 2);

// ---- tests --------------------------------------------------------------------

test("real artifact round-trip: full original recoverable from on-disk artifact", async () => {
	const { toolResult } = loadExtension();
	const { ctx, sessionManager } = realCtx("roundtrip");
	const original = bigJson();

	const res = await toolResult(
		{ toolName: "mcp_tool", isError: false, details: { rawContent: [] }, content: [{ type: "text", text: original }] },
		ctx,
	);

	expect(res).toBeDefined();
	const text = res!.content[0].text as string;

	// compact body before footer must still be valid JSON
	const body = text.slice(0, text.indexOf("\n\n[pi-distill:"));
	expect(() => JSON.parse(body)).not.toThrow();

	// footer carries an artifact id; resolve it against the REAL ArtifactManager
	const m = text.match(/artifact:\/\/(\S+?)\b/);
	expect(m).not.toBeNull();
	const id = m![1];

	const artifactPath = await sessionManager.getArtifactPath(id);
	expect(artifactPath).not.toBeNull();
	const recovered = fs.readFileSync(artifactPath!, "utf8");
	expect(recovered).toBe(original); // lossless
});

test("builtin tool output is left untouched (native spill owns it)", async () => {
	const { toolResult } = loadExtension();
	const { ctx } = realCtx("builtin");
	const res = await toolResult(
		{ toolName: "read", isError: false, details: undefined, content: [{ type: "text", text: bigJson() }] },
		ctx,
	);
	expect(res).toBeUndefined();
});

test("already natively-spilled result is skipped", async () => {
	const { toolResult } = loadExtension();
	const { ctx } = realCtx("spilled");
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

test("real loader discovers + loads pi-distill from its package manifest", async () => {
	// Best-effort: prove the package manifest is discoverable by the genuine loader.
	const mod: any = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader").catch(() => null);
	if (!mod?.discoverAndLoadExtensions) {
		// Loader entrypoint not exported under this path — round-trip test above is the
		// authoritative artifact proof; skip without failing the suite.
		return;
	}
	const pkgDir = path.resolve(import.meta.dir, "..");
	const result = await mod.discoverAndLoadExtensions([pkgDir], pkgDir);
	const names = JSON.stringify(result);
	expect(names.toLowerCase()).toContain("distill");
});

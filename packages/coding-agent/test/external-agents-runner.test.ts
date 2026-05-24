import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildContextSummary,
	extractDelegationSummary,
	runExternalAgent,
	runExternalAgentsParallel,
} from "../src/external-agents/runner";
import type {
	DelegationSummary,
	ExternalAgentEvent,
	ExternalAgentProvider,
	ExternalAgentResult,
} from "../src/external-agents/types";

const tempDirs: string[] = [];
let originalPath: string | undefined;
let originalFakeAgentLog: string | undefined;
let originalFakeAcpxExit: string | undefined;
let originalFakeAcpxStderr: string | undefined;

interface FakeHarness {
	root: string;
	binDir: string;
	cwd: string;
	logPath: string;
}

interface CommandLogEntry {
	bin: string;
	argv: string[];
	cwd: string;
}

beforeEach(() => {
	originalPath = process.env.PATH;
	originalFakeAgentLog = process.env.FAKE_AGENT_LOG;
	originalFakeAcpxExit = process.env.FAKE_ACPX_EXIT;
	originalFakeAcpxStderr = process.env.FAKE_ACPX_STDERR;
});

afterEach(async () => {
	restoreEnv("PATH", originalPath);
	restoreEnv("FAKE_AGENT_LOG", originalFakeAgentLog);
	restoreEnv("FAKE_ACPX_EXIT", originalFakeAcpxExit);
	restoreEnv("FAKE_ACPX_STDERR", originalFakeAcpxStderr);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

function fakeBinarySource(bin: string, body: string): string {
	return `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const logPath = process.env.FAKE_AGENT_LOG;
if (!logPath) throw new Error("FAKE_AGENT_LOG missing");
appendFileSync(logPath, JSON.stringify({ bin: ${JSON.stringify(bin)}, argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");

${body}
`;
}

async function writeFakeBinary(binDir: string, name: string, body: string): Promise<void> {
	const file = path.join(binDir, name);
	await Bun.write(file, fakeBinarySource(name, body));
	await fs.chmod(file, 0o755);
}

async function createHarness(binaries: Record<string, string>): Promise<FakeHarness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-external-runner-"));
	tempDirs.push(root);
	const binDir = path.join(root, "bin");
	const cwd = path.join(root, "cwd");
	const logPath = path.join(root, "commands.ndjson");
	await fs.mkdir(binDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });

	await Promise.all(Object.entries(binaries).map(([name, body]) => writeFakeBinary(binDir, name, body)));
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
	process.env.FAKE_AGENT_LOG = logPath;
	const realCwd = await fs.realpath(cwd);
	return { root, binDir, cwd: realCwd, logPath };
}

async function readCommandLog(logPath: string): Promise<CommandLogEntry[]> {
	if (!(await Bun.file(logPath).exists())) return [];
	const text = await Bun.file(logPath).text();
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as CommandLogEntry);
}

const acpxBody = `
if (process.env.FAKE_ACPX_STDERR) console.error(process.env.FAKE_ACPX_STDERR);
const exitCode = Number(process.env.FAKE_ACPX_EXIT ?? "0");
if (exitCode === 0) {
	console.log(JSON.stringify({ type: "message", text: "hello " }));
	console.log(JSON.stringify({ event: "tool_call", tool: "read", id: "tool-1" }));
	console.log(JSON.stringify({ event: "tool_result", name: "read", id: "tool-1", result: { ok: true } }));
	console.log(JSON.stringify({ type: "final", final: "world" }));
}
process.exit(exitCode);
`;

function eventsOfType<T extends ExternalAgentEvent["type"]>(events: ExternalAgentEvent[], type: T) {
	return events.filter((event): event is Extract<ExternalAgentEvent, { type: T }> => event.type === type);
}

describe("external agent runner", () => {
	it("spawns acpx from PATH, parses NDJSON events, and returns final text on exit 0", async () => {
		const harness = await createHarness({ acpx: acpxBody });
		const observed: ExternalAgentEvent[] = [];

		const result = await runExternalAgent(
			{
				backend: "acpx",
				provider: "gemini",
				mode: "exec",
				prompt: "summarize this",
				cwd: harness.cwd,
				session: "gemini-session",
			},
			event => observed.push(event),
		);

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.provider).toBe("gemini");
		expect(result.backend).toBe("acpx");
		expect(result.text).toBe("hello world");
		expect(observed).toEqual(result.events);
		expect(eventsOfType(result.events, "json")).toHaveLength(4);
		expect(eventsOfType(result.events, "text").map(event => event.text)).toEqual(["hello ", "world"]);
		expect(eventsOfType(result.events, "tool_start")[0]).toMatchObject({ name: "read", id: "tool-1" });
		expect(eventsOfType(result.events, "tool_end")[0]).toMatchObject({ name: "read", id: "tool-1" });

		const log = await readCommandLog(harness.logPath);
		expect(log).toEqual([
			{
				bin: "acpx",
				argv: [
					"--cwd",
					harness.cwd,
					"--format",
					"json",
					"gemini",
					"-s",
					"gemini-session",
					"exec",
					"summarize this",
				],
				cwd: harness.cwd,
			},
		]);
	});

	it("reports acpx failure and stderr as an error event", async () => {
		const harness = await createHarness({ acpx: acpxBody });
		process.env.FAKE_ACPX_EXIT = "7";
		process.env.FAKE_ACPX_STDERR = "fake acpx failed";

		const result = await runExternalAgent({
			backend: "acpx",
			provider: "gemini",
			mode: "exec",
			prompt: "fail please",
			cwd: harness.cwd,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(7);
		expect(eventsOfType(result.events, "error").map(event => event.message)).toContain("fake acpx failed");
		expect(eventsOfType(result.events, "status").at(-1)?.message).toBe("external agent failed");
		expect(await readCommandLog(harness.logPath)).toHaveLength(1);
	});

	it("invokes tmux new-session and send-keys through PATH fakes", async () => {
		const harness = await createHarness({ tmux: "process.exit(0);" });

		const result = await runExternalAgent({
			backend: "tmux",
			provider: "claude",
			prompt: "hello tmux",
			cwd: harness.cwd,
			session: "tmux-session",
		});

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.session).toBe("tmux-session");
		expect(eventsOfType(result.events, "terminal").map(event => event.command)).toEqual([
			["tmux", "new-session", "-d", "-s", "tmux-session", "claude"],
			["tmux", "send-keys", "-t", "tmux-session", "hello tmux", "C-m"],
		]);
		expect(await readCommandLog(harness.logPath)).toEqual([
			{ bin: "tmux", argv: ["new-session", "-d", "-s", "tmux-session", "claude"], cwd: harness.cwd },
			{ bin: "tmux", argv: ["send-keys", "-t", "tmux-session", "hello tmux", "C-m"], cwd: harness.cwd },
		]);
	});

	it("invokes cmux new-split and send through PATH fakes", async () => {
		const harness = await createHarness({ cmux: "process.exit(0);" });

		const result = await runExternalAgent({
			backend: "cmux",
			provider: "codex",
			prompt: "hello cmux",
			cwd: harness.cwd,
			session: "cmux-session",
		});

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(eventsOfType(result.events, "terminal").map(event => event.command)).toEqual([
			["cmux", "new-split", "right"],
			["cmux", "send", "codex hello cmux"],
		]);
		expect(await readCommandLog(harness.logPath)).toEqual([
			{ bin: "cmux", argv: ["new-split", "right"], cwd: harness.cwd },
			{ bin: "cmux", argv: ["send", "codex hello cmux"], cwd: harness.cwd },
		]);
	});

	it("runs external agents in parallel with one result per request and preserved providers", async () => {
		const harness = await createHarness({ acpx: acpxBody });
		const observed: Array<{ index: number; provider: string; type: ExternalAgentEvent["type"] }> = [];

		const results = await runExternalAgentsParallel(
			[
				{ backend: "acpx", provider: "claude", mode: "exec", prompt: "first", cwd: harness.cwd },
				{ backend: "acpx", provider: "gemini", mode: "exec", prompt: "second", cwd: harness.cwd },
			],
			(event, index, request) => observed.push({ index, provider: request.provider, type: event.type }),
		);

		expect(results).toHaveLength(2);
		expect(results.map(result => result.provider)).toEqual(["claude", "gemini"]);
		expect(results.every(result => result.success)).toBe(true);
		expect(results.map(result => result.text)).toEqual(["hello world", "hello world"]);
		expect(observed.some(event => event.index === 0 && event.provider === "claude" && event.type === "json")).toBe(
			true,
		);
		expect(observed.some(event => event.index === 1 && event.provider === "gemini" && event.type === "json")).toBe(
			true,
		);

		const providers = (await readCommandLog(harness.logPath))
			.map(entry => entry.argv.find(arg => arg === "claude" || arg === "gemini" || arg === "codex"))
			.sort();
		expect(providers).toEqual(["claude", "gemini"]);
	});
});

describe("extractDelegationSummary", () => {
	it("uses only last DELEGATION_SUMMARY: marker when multiple are present", () => {
		const text = [
			"Raw output before first marker",
			"more raw output",
			"DELEGATION_SUMMARY:",
			"First summary line.",
			"First summary second line.",
			"More raw output between markers",
			"DELEGATION_SUMMARY:",
			"Final summary line.",
			"Final summary second line.",
		].join("\n");

		const result: DelegationSummary = extractDelegationSummary(text);

		expect(result.text).toBe("Final summary line.\nFinal summary second line.");
		expect(result.lines).toBe(2);
		// Earlier marker content must not leak
		expect(result.text).not.toContain("First summary");
	});

	it("returns { lines: 0 } with no text when marker is absent", () => {
		const text = "Some raw agent output\nwith multiple lines\nbut no summary marker.";

		const result: DelegationSummary = extractDelegationSummary(text);

		expect(result.lines).toBe(0);
		expect(result.text).toBeUndefined();
	});

	it("caps line count at MAX_SUMMARY_LINES (20)", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}`);
		const text = `DELEGATION_SUMMARY:\n${lines.join("\n")}`;

		const result: DelegationSummary = extractDelegationSummary(text);

		expect(result.lines).toBe(20);
		expect(result.text!.split("\n")).toHaveLength(20);
		expect(result.text!).toContain("Line 1");
		expect(result.text!).toContain("Line 20");
		expect(result.text!).not.toContain("Line 21");
	});
});

describe("buildContextSummary", () => {
	function makeResult(
		provider: ExternalAgentProvider,
		overrides: Partial<ExternalAgentResult> = {},
	): ExternalAgentResult {
		return {
			provider,
			backend: "acpx",
			session: undefined,
			cwd: "/tmp",
			events: [],
			text: "",
			exitCode: 0,
			success: true,
			...overrides,
		};
	}

	it("produces deterministic status line without dumping raw result.text when no marker present", () => {
		const results: ExternalAgentResult[] = [
			makeResult("gemini", {
				success: true,
				text: "Very long raw output that should not appear in context summary.",
				exitCode: 0,
				events: [
					{ type: "tool_start", name: "read", id: "t1", value: {} },
					{ type: "tool_start", name: "bash", id: "t2", value: {} },
				],
			}),
			makeResult("claude", {
				success: false,
				text: "Another long raw output that must not leak.",
				exitCode: 1,
				events: [
					{ type: "error", message: "connection refused" },
					{ type: "error", message: "timeout" },
					{ type: "error", message: "retry failed" },
					{ type: "error", message: "final error" },
					{ type: "tool_start", name: "read", id: "t3", value: {} },
				],
			}),
		];

		const summary = buildContextSummary(results);

		// Must not contain raw text from either result
		expect(summary).not.toContain("Very long raw output");
		expect(summary).not.toContain("Another long raw output");
		// Must contain deterministic status icons and providers
		expect(summary).toContain("✓ gemini");
		expect(summary).toContain("✗ claude");
		expect(summary).toContain("tools: 2");
		expect(summary).toContain("exit=1");
		// Must cap error count at 3 in summary
		expect(summary).toContain("errors:");
		expect(summary).toContain("[+1 more]");
	});

	it("uses extracted delegation summary text when marker is present", () => {
		const results: ExternalAgentResult[] = [
			makeResult("gemini", {
				success: true,
				text: "Raw preamble\nDELEGATION_SUMMARY:\nTask completed: refactored auth module.",
			}),
			makeResult("claude", {
				success: false,
				text: "No marker here.",
				exitCode: 2,
				events: [{ type: "error", message: "auth failed" }],
			}),
		];

		const summary = buildContextSummary(results);

		// gemini uses delegated summary
		expect(summary).toContain("Task completed: refactored auth module.");
		// claude has no marker → fallback status line
		expect(summary).toContain("✗ claude");
		expect(summary).toContain("exit=2");
	});
});

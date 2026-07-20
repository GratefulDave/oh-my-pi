// ---------------------------------------------------------------------------
// Proves the parent observer rolls up subagent activity that arrives on the
// shared EventBus (TASK_SUBAGENT_PROGRESS_CHANNEL / *_LIFECYCLE_CHANNEL).
//
// Regression target: subagents run in a separate AgentSession, so their own
// pi.on(...) tool/token events never reach the parent observer extension. The
// only path is the parent EventBus fan-in channels — this test exercises that
// full wiring through the extension's default export.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from "bun:test";
import observer from "../src/extension";
import { stripAnsi } from "../src/renderer";
import {
	getStats,
	getSubagentTotals,
	onSubagentLifecycle,
	onSubagentProgress,
	resetStats,
} from "../src/stats-collector";

const PROGRESS_CHANNEL = "task:subagent:progress";
const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const IRC_CHANNEL = "irc:message";

type FakeCustomTheme = {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
	dim?: (text: string) => string;
};

type FakeCustomView = {
	render(width: number, height: number): string[];
	destroy(): void;
};

type FakeCommandContext = {
	cwd: string;
	ui: {
		setEditorText(text: string): void;
		custom<T>(
			factory: (
				tui: { requestRender(): void; terminal?: { rows: number } },
				theme: FakeCustomTheme,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
	};
};

type FakeCommand = {
	description: string;
	handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
};

/** Minimal EventBus matching coding-agent's on/emit contract. */
class FakeEventBus {
	#listeners = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) this.#listeners.set(channel, new Set());
		this.#listeners.get(channel)!.add(handler);
		return () => this.#listeners.get(channel)?.delete(handler);
	}
	emit(channel: string, data: unknown): void {
		for (const h of this.#listeners.get(channel) ?? []) h(data);
	}
}

/** Minimal ExtensionAPI stub exposing just what observer() touches. */
function makeFakePi() {
	const events = new FakeEventBus();
	const sessionHandlers = new Map<string, (event: unknown) => void>();
	const commands = new Map<string, FakeCommand>();
	const pi = {
		events,
		setLabel() {},
		on(event: string, handler: (event: unknown) => void) {
			sessionHandlers.set(event, handler);
		},
		registerCommand(name: string, command: FakeCommand) {
			commands.set(name, command);
		},
	};
	return { pi: pi as Parameters<typeof observer>[0], events, sessionHandlers, commands };
}

function isFakeCustomView(value: unknown): value is FakeCustomView {
	return (
		value != null &&
		typeof value === "object" &&
		"render" in value &&
		"destroy" in value &&
		typeof value.render === "function" &&
		typeof value.destroy === "function"
	);
}

describe("pi-observer subagent fan-in", () => {
	beforeEach(() => {
		resetStats();
	});

	test("getSubagentTotals starts empty", () => {
		const totals = getSubagentTotals();
		expect(totals).toEqual({ count: 0, activeCount: 0, tokens: 0, toolCount: 0, cost: 0 });
		expect(getStats().subagents.size).toBe(0);
	});

	test("progress event updates cumulative totals (overwrite, not add)", () => {
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 100, toolCount: 2, cost: 0.01 });
		expect(getSubagentTotals()).toEqual({ count: 1, activeCount: 1, tokens: 100, toolCount: 2, cost: 0.01 });

		// Second snapshot is cumulative for the same id -> overwrite, not add.
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 250, toolCount: 5, cost: 0.03 });
		expect(getSubagentTotals()).toEqual({ count: 1, activeCount: 1, tokens: 250, toolCount: 5, cost: 0.03 });
	});

	test("progress preserves hierarchy fields when later cumulative updates omit them", () => {
		onSubagentProgress({
			id: "a1",
			agent: "explore",
			status: "running",
			tokens: 100,
			toolCount: 2,
			cost: 0.01,
			agentSource: "project",
			sessionFile: "/tmp/session.jsonl",
			recentTools: [{ tool: "read", args: "dashboard.ts", endMs: 10 }],
			extractedToolData: {
				task: [{ results: [], progress: [{ id: "nested", agent: "executor", status: "running", task: "nested" }] }],
			},
			inflightTaskDetails: { results: [], progress: [{ id: "live", agent: "reviewer", status: "running" }] },
		});
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 250, toolCount: 5, cost: 0.03 });

		const subagent = getStats().subagents.get("a1");
		expect(subagent?.agentSource).toBe("project");
		expect(subagent?.sessionFile).toBe("/tmp/session.jsonl");
		expect(subagent?.recentTools).toEqual([{ tool: "read", args: "dashboard.ts", endMs: 10 }]);
		expect(subagent?.extractedToolData?.task).toHaveLength(1);
		expect(subagent?.inflightTaskDetails).toEqual({
			results: [],
			progress: [{ id: "live", agent: "reviewer", status: "running" }],
		});
	});

	test("lifecycle merge does not wipe task hierarchy fields", () => {
		onSubagentProgress({
			id: "a1",
			agent: "explore",
			status: "running",
			tokens: 100,
			toolCount: 2,
			cost: 0.01,
			recentTools: [{ tool: "edit", args: "hierarchy.ts", endMs: 10 }],
			extractedToolData: { task: [{ results: [{ id: "done", agent: "executor", status: "completed" }] }] },
			inflightTaskDetails: { results: [], async: { state: "running", jobId: "job-1", type: "task" } },
		});
		onSubagentLifecycle("a1", "explore", "completed", { task: "trace bug" });

		const subagent = getStats().subagents.get("a1");
		expect(subagent?.status).toBe("completed");
		expect(subagent?.task).toBe("trace bug");
		expect(subagent?.recentTools).toEqual([{ tool: "edit", args: "hierarchy.ts", endMs: 10 }]);
		expect(subagent?.extractedToolData?.task).toHaveLength(1);
		expect(subagent?.inflightTaskDetails).toEqual({
			results: [],
			async: { state: "running", jobId: "job-1", type: "task" },
		});
	});

	test("multiple subagents sum; lifecycle flips active count", () => {
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 100, toolCount: 2, cost: 0.01 });
		onSubagentProgress({ id: "a2", agent: "executor", status: "running", tokens: 300, toolCount: 4, cost: 0.05 });
		const summed = getSubagentTotals();
		expect(summed.count).toBe(2);
		expect(summed.activeCount).toBe(2);
		expect(summed.tokens).toBe(400);
		expect(summed.toolCount).toBe(6);
		expect(summed.cost).toBeCloseTo(0.06, 6);

		onSubagentLifecycle("a1", "explore", "completed");
		const totals = getSubagentTotals();
		expect(totals.count).toBe(2);
		expect(totals.activeCount).toBe(1);
		expect(totals.tokens).toBe(400);
	});

	test("end-to-end: parent observer reflects a subagent event via the shared EventBus", () => {
		const { pi, events } = makeFakePi();
		observer(pi);

		// Subagent emits aggregated progress on the PARENT bus (as the task executor does).
		events.emit(PROGRESS_CHANNEL, {
			index: 0,
			agent: "explore",
			task: "trace bug",
			progress: {
				id: "sub-1",
				agent: "explore",
				status: "running",
				tokens: 1234,
				toolCount: 7,
				cost: 0.12,
				description: "Trace bug",
				currentTool: "read",
				durationMs: 1500,
				resolvedModel: "anthropic/claude-sonnet-4",
				agentSource: "builtin",
				sessionFile: "/tmp/sub-1.jsonl",
				recentTools: [{ tool: "read", args: "stats", endMs: 10 }],
				extractedToolData: { task: [{ results: [], progress: [] }] },
				inflightTaskDetails: { results: [], progress: [] },
			},
		});

		const totals = getSubagentTotals();
		expect(totals.count).toBe(1);
		expect(totals.tokens).toBe(1234);
		expect(totals.toolCount).toBe(7);
		expect(totals.cost).toBeCloseTo(0.12, 6);
		const subagent = getStats().subagents.get("sub-1");
		expect(subagent?.description).toBe("Trace bug");
		expect(subagent?.task).toBe("trace bug");
		expect(subagent?.currentTool).toBe("read");
		expect(subagent?.durationMs).toBe(1500);
		expect(subagent?.resolvedModel).toBe("anthropic/claude-sonnet-4");
		expect(subagent?.agentSource).toBe("builtin");
		expect(subagent?.sessionFile).toBe("/tmp/sub-1.jsonl");
		expect(subagent?.recentTools).toEqual([{ tool: "read", args: "stats", endMs: 10 }]);
		expect(subagent?.extractedToolData?.task).toHaveLength(1);
		expect(subagent?.inflightTaskDetails).toEqual({ results: [], progress: [] });

		// Lifecycle "completed" marks it inactive but keeps its accumulated totals.
		events.emit(LIFECYCLE_CHANNEL, { id: "sub-1", agent: "explore", status: "completed", index: 0 });
		const after = getSubagentTotals();
		expect(after.activeCount).toBe(0);
		expect(after.tokens).toBe(1234);
	});

	test("observe command tolerates custom UI themes without dim helper", async () => {
		const { pi, commands } = makeFakePi();
		observer(pi);
		const command = commands.get("observe");
		expect(command).toBeDefined();
		let editorText: string | undefined;
		let rendered: string[] = [];
		const ctx: FakeCommandContext = {
			cwd: "/tmp",
			ui: {
				setEditorText(text: string): void {
					editorText = text;
				},
				async custom<T>(factory): Promise<T> {
					const view = factory(
						{ requestRender() {} },
						{
							fg(color: string, text: string): string {
								if (color !== "dim") throw new Error(`Unknown theme color: ${color}`);
								return text;
							},
							bold(text: string): string {
								return text;
							},
						},
						undefined,
						() => {},
					);
					if (!isFakeCustomView(view)) throw new Error("Expected observer dashboard view");
					rendered = view.render(120, 50).map(stripAnsi);
					view.destroy();
					return undefined as T;
				},
			},
		};

		await command!.handler("", ctx);

		expect(editorText).toBe("");
		expect(rendered).toContain("session-observability");
		expect(rendered.some(line => line.includes("Observability · 1 node ┬ Session observability"))).toBe(true);
	});

	test("end-to-end: optional IRC EventBus records are bounded and normalized", () => {
		const { pi, events } = makeFakePi();
		observer(pi);

		events.emit(IRC_CHANNEL, {
			timestamp: 1,
			channel: "#agents",
			from: "Main",
			to: "#agents",
			body: "hello",
			kind: "message",
			delivered: ["executor"],
			failed: [],
		});

		expect(getStats().ircMessages).toEqual([
			{
				timestamp: 1,
				channel: "#agents",
				from: "Main",
				to: "#agents",
				body: "hello",
				kind: "message",
				delivered: ["executor"],
				failed: [],
			},
		]);
	});

	test("end-to-end: session IRC messages are normalized without host changes", () => {
		const { pi, sessionHandlers } = makeFakePi();
		observer(pi);

		sessionHandlers.get("irc_message")?.({
			message: {
				customType: "irc:relay",
				timestamp: 2,
				details: { from: "executor", to: "@Main", body: "/me finished", kind: "reply" },
			},
		});

		expect(getStats().ircMessages.at(-1)).toEqual({
			timestamp: 2,
			channel: "@Main",
			from: "executor",
			to: "@Main",
			body: "/me finished",
			kind: "reply",
			delivered: [],
			failed: [],
		});
	});

	test("malformed payloads are ignored", () => {
		const { pi, events } = makeFakePi();
		observer(pi);
		events.emit(PROGRESS_CHANNEL, undefined);
		events.emit(PROGRESS_CHANNEL, { progress: null });
		events.emit(PROGRESS_CHANNEL, { progress: { agent: "x" } }); // no id
		events.emit(LIFECYCLE_CHANNEL, { status: "completed" }); // no id
		expect(getSubagentTotals().count).toBe(0);
	});
});

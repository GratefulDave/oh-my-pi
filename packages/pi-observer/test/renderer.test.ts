import { describe, expect, test } from "bun:test";
import { buildObserverHierarchy } from "../src/hierarchy";
import { renderLiveObserverWidgetLines } from "../src/live-widget";
import { IrcRenderer, SubagentRenderer, stripAnsi } from "../src/renderer";
import type { IrcMessageActivity, ObserverStats, SubagentActivity } from "../src/stats-collector";
import { onIrcMessage, onSubagentProgress, resetStats } from "../src/stats-collector";

const NOW = Date.UTC(2026, 5, 5, 13, 42, 0);

function makeStats(subagents: SubagentActivity[], ircMessages: IrcMessageActivity[] = []): ObserverStats {
	return {
		sessionStartTime: NOW,
		agentRuns: 1,
		turns: [],
		currentTurn: null,
		activeToolCalls: new Map(),
		totalTokensInput: 0,
		totalTokensOutput: 0,
		toolCallCounts: new Map(),
		estimatedCost: 0,
		subagents: new Map(subagents.map(subagent => [subagent.id, subagent])),
		ircMessages,
	};
}

function makeSubagent(
	update: Partial<SubagentActivity> & Pick<SubagentActivity, "id" | "agent" | "status">,
): SubagentActivity {
	return {
		tokens: 0,
		toolCount: 0,
		cost: 0,
		lastUpdate: NOW,
		index: 0,
		recentOutput: [],
		durationMs: 0,
		startedAt: NOW - 12_000,
		...update,
	};
}

describe("diagnostic renderers", () => {
	test("renders exact running/completed/queued agent grammar", () => {
		const renderer = new SubagentRenderer();
		const stats = makeStats([
			makeSubagent({
				id: "run-1",
				agent: "executor",
				status: "running",
				task: "Build dashboard",
				currentTool: "edit",
				resolvedModel: "anthropic/claude-sonnet-4",
			}),
			makeSubagent({
				id: "done-1",
				agent: "reviewer",
				status: "completed",
				task: "Review dashboard",
				tokens: 1540,
				toolCount: 4,
				durationMs: 2300,
				index: 1,
			}),
			makeSubagent({ id: "queued-1", agent: "test-engineer", status: "pending", task: "Run checks", index: 2 }),
		]);

		const lines = renderer.render(stats, { width: 120, now: NOW, spinnerFrame: 0 }).lines.map(stripAnsi);
		expect(lines[0]).toBe("● Agents");
		expect(lines[1]).toStartWith(" ▶ [executor anthropic/claude-sonnet-4] Build dashboard ");
		expect(lines[2]).toBe("  └ Running in background (ID: run-1)");
		expect(lines[3]).toBe("  └ using edit");
		expect(lines[4]).toStartWith(" ✔ [reviewer] Review dashboard · 4 tool uses · 1.5k tokens · 2.3s ");
		expect(lines[5]).toBe("o 1 queued");
	});

	test("renders IRC and direct-message hierarchy with timestamps and actions", () => {
		const renderer = new IrcRenderer();
		const lines = renderer.render(
			[
				{
					timestamp: NOW,
					channel: "#agents",
					from: "Main",
					to: "#agents",
					body: "status?",
					kind: "message",
					delivered: ["executor"],
					failed: [],
				},
				{
					timestamp: NOW,
					channel: "@Main",
					from: "executor",
					to: "@Main",
					body: "/me fixed it",
					kind: "reply",
					delivered: ["Main"],
					failed: [],
				},
			],
			{ width: 100, now: NOW },
		).lines;

		expect(lines).toEqual([
			"▶ IRC #agents",
			"  └ [13:42] <Main> status?",
			"● Intercom @Main (Direct Message)",
			"  └ [13:42] * executor fixed it",
		]);
	});

	test("renders selected-agent detail with audit metadata and IRC context", () => {
		const renderer = new SubagentRenderer();
		const stats = makeStats(
			[
				makeSubagent({
					id: "run-1",
					agent: "executor",
					status: "running",
					task: "Build dashboard",
					assignment: "Implement master detail",
					currentTool: "edit",
					currentToolArgs: "renderer.ts",
					recentOutput: ["patched hierarchy"],
					contextTokens: 64000,
					contextWindow: 200000,
					tokens: 1540,
					toolCount: 4,
					cost: 0.1234,
					resolvedModel: "anthropic/claude-sonnet-4",
				}),
			],
			[
				{
					timestamp: NOW,
					channel: "run-1",
					from: "Main",
					to: "run-1",
					body: "need status",
					kind: "message",
					delivered: ["run-1"],
					failed: [],
				},
			],
		);

		const lines = renderer
			.render(stats, {
				width: 120,
				now: NOW,
				includeDetails: true,
				selectedAgentIndex: 0,
				ircMessages: stats.ircMessages,
			})
			.lines.map(stripAnsi);
		expect(lines).toContain("● Selected Agent");
		expect(lines).toContain("  └ Prompt: Build dashboard");
		expect(lines).toContain("  └ Task: Implement master detail");
		expect(lines).toContain("  └ Activity: edit renderer.ts");
		expect(lines).toContain("  └ Trace: patched hierarchy");
		expect(lines).toContain("  └ Model: anthropic/claude-sonnet-4");
		expect(lines).toContain("  └ Metrics: 4 tools · 1.5k tokens · 12.0s · $0.1234");
		expect(lines).toContain("  └ Context: 64.0k tokens / 200.0k tokens");
		expect(lines).toContain("  └ IRC: [13:42] <Main> need status");
	});

	test("compact live widget preserves Agents hierarchy header", () => {
		resetStats();
		onSubagentProgress({
			id: "run-1",
			agent: "executor",
			status: "running",
			tokens: 1200,
			toolCount: 2,
			cost: 0.01,
			task: "Build dashboard",
			currentTool: "edit",
		});
		onIrcMessage({
			timestamp: NOW,
			channel: "#agents",
			from: "Main",
			to: "#agents",
			body: "status?",
			kind: "message",
			delivered: ["executor"],
			failed: [],
		});

		const lines = renderLiveObserverWidgetLines(NOW)?.map(stripAnsi);
		expect(lines?.[0]).toBe("● Agents");
		expect(lines?.some(line => line.startsWith("⠋ [executor] Build dashboard · "))).toBe(true);
		expect(lines).toContain("  └ using edit");
		expect(lines).toContain("▶ IRC #agents");
	});

	test("pure observer hierarchy orders phase groups and nested task nodes", () => {
		const stats = makeStats([
			makeSubagent({
				id: "run-1",
				agent: "executor",
				status: "running",
				task: "Build dashboard",
				currentTool: "edit",
				recentTools: [{ tool: "read", args: "hierarchy.ts", endMs: NOW }],
				extractedToolData: {
					task: [
						{
							results: [],
							progress: [{ id: "nested-1", agent: "reviewer", status: "running", task: "Review nested" }],
						},
					],
				},
			}),
		]);

		const hierarchy = buildObserverHierarchy(stats, NOW);
		const phase = hierarchy.rootNodes[0]!;
		expect(phase.kind).toBe("phase");
		// Top level is Agents-rooted: Tasks/Activity are no longer flat siblings —
		// they live nested under each agent (Agents → agent → Tasks → task → Activity).
		expect(phase.children.map(node => node.label)).toEqual(["Agents", "Intercom", "Metrics"]);
		const agents = hierarchy.getChildren("group:agents");
		expect(agents.map(node => node.label)).toEqual(["Build dashboard"]);
		const taskLabels = hierarchy.getChildren("agent:run-1:tasks").map(node => node.label);
		expect(taskLabels).toContain("Review nested");
		expect(taskLabels).toContain("edit");
		expect(taskLabels).toContain("read");
		// Activity drills one level below a task: Task → Activity N.
		const nestedTask = hierarchy.getChildren("agent:run-1:tasks").find(node => node.label === "Review nested");
		expect(nestedTask?.children.every(child => child.kind === "activity")).toBe(true);
	});
	test("render keys suppress unchanged redraws", () => {
		const renderer = new SubagentRenderer();
		const stats = makeStats([makeSubagent({ id: "run-1", agent: "executor", status: "running", task: "Build" })]);
		expect(renderer.render(stats, { width: 80, now: NOW, spinnerFrame: 0 }).changed).toBe(true);
		expect(renderer.render(stats, { width: 80, now: NOW, spinnerFrame: 0 }).changed).toBe(false);
		expect(renderer.render(stats, { width: 80, now: NOW, spinnerFrame: 1 }).changed).toBe(false);
	});
});

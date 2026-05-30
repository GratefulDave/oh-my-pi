/**
 * Task renderer — Claude Code-style UX contract tests.
 *
 * Verifies the call card and progress section shapes introduced for the
 * Claude Code-style background task UX:
 *
 *   ▸ Explore  Analyze git history
 *     └ Running in background (ID: 60ba7ab9-075b-45f)
 *
 * and the live progress section:
 *
 *   ✣ Working…
 *   ● Agents
 *     └ ● Explore  Analyze git history · 0s
 *         └ thinking…
 */

import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getThemeByName } from "../src/modes/theme/theme";
import { renderCall, renderResult, taskToolRenderer } from "../src/task/render";
import type { AgentProgress, TaskParams, TaskToolDetails } from "../src/task/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDarkTheme() {
	const t = await getThemeByName("dark");
	if (!t) throw new Error("dark theme unavailable in test environment");
	return t;
}

// Build a minimal AgentProgress for a running subagent.
function makeRunningProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "60ba7ab9-075b-45f",
		agent: "Explore",
		agentSource: "bundled",
		status: "running",
		task: "Analyze git history",
		description: "Analyze git history",
		assignment: "Analyze the git history of this repo.",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test 1 — renderCall card contract
// ---------------------------------------------------------------------------

describe("renderCall — Claude Code-style launch card", () => {
	it("emits ▸ <Agent> <description> and 'Running in background (ID:…)' for each task", async () => {
		const theme = await getDarkTheme();

		const args: TaskParams = {
			agent: "Explore",
			tasks: [
				{
					id: "60ba7ab9-075b-45f",
					description: "Analyze git history",
					assignment: "Analyze the git history of this repo.",
				},
			],
		};

		const component = renderCall(args, { expanded: false, isPartial: false }, theme);
		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("▸");
		expect(rendered).toContain("Explore");
		expect(rendered).toContain("Analyze git history");
		expect(rendered).toContain("Running in background (ID: 60ba7ab9-075b-45f)");
	});

	it("emits a card per task when multiple tasks are provided", async () => {
		const theme = await getDarkTheme();

		const args: TaskParams = {
			agent: "task",
			tasks: [
				{
					id: "aaa-001",
					description: "First task",
					assignment: "Do the first thing.",
				},
				{
					id: "bbb-002",
					description: "Second task",
					assignment: "Do the second thing.",
				},
			],
		};

		const component = taskToolRenderer.renderCall(args, { expanded: false, isPartial: false }, theme);
		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("Running in background (ID: aaa-001)");
		expect(rendered).toContain("Running in background (ID: bbb-002)");
		expect(rendered).toContain("First task");
		expect(rendered).toContain("Second task");
	});

	it("omits the ID suffix when the task has no id", async () => {
		const theme = await getDarkTheme();

		const args: TaskParams = {
			agent: "Explore",
			tasks: [
				{
					id: "",
					description: "Unnamed task",
					assignment: "Do something.",
				},
			],
		};

		const component = renderCall(args, { expanded: false, isPartial: false }, theme);
		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("Running in background");
		expect(rendered).not.toContain("ID:");
	});

	it("uses assignment first line as label when description and id are absent", async () => {
		const theme = await getDarkTheme();

		const args: TaskParams = {
			agent: "task",
			tasks: [
				{
					id: "",
					description: "",
					assignment: "Process the queue items",
				},
			],
		};

		const component = renderCall(args, { expanded: false, isPartial: false }, theme);
		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("Process the queue items");
	});
});

// ---------------------------------------------------------------------------
// Test 2 — renderResult progress contract
// ---------------------------------------------------------------------------

describe("renderResult — live progress section", () => {
	it("shows Working header and ● Agents section while progress is partial and agents are running", async () => {
		const theme = await getDarkTheme();

		const progress = makeRunningProgress({ lastIntent: "thinking…" });

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};

		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			theme,
		);

		const rendered = sanitizeText(component.render(120).join("\n"));

		// ✣ Working… header
		expect(rendered).toContain("Working");
		// ● Agents section header
		expect(rendered).toContain("Agents");
		// Agent name
		expect(rendered).toContain("Explore");
		// Task description
		expect(rendered).toContain("Analyze git history");
		// Last intent
		expect(rendered).toContain("thinking");
	});

	it("shows Working and Agents when isPartial is false but results is empty", async () => {
		const theme = await getDarkTheme();

		const progress = makeRunningProgress();

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			theme,
		);

		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("Working");
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("Explore");
	});

	it("falls back to lastIntent in the child message line when currentTool is absent", async () => {
		const theme = await getDarkTheme();

		const progress = makeRunningProgress({ lastIntent: "thinking…" });

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			theme,
		);

		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("thinking");
	});

	it("renders the default 'thinking…' message when no intent, tool, or output is set", async () => {
		const theme = await getDarkTheme();

		const progress = makeRunningProgress({
			lastIntent: undefined,
			currentTool: undefined,
			recentTools: [],
			recentOutput: [],
		});

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			theme,
		);

		const rendered = sanitizeText(component.render(120).join("\n"));
		// buildRunningMessage falls back to "thinking…" (unicode ellipsis)
		expect(rendered).toMatch(/thinking/);
	});

	it("does not show Working header when all agents are completed", async () => {
		const theme = await getDarkTheme();

		const progress = makeRunningProgress({ status: "completed" });

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			theme,
		);

		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).not.toContain("Working");
	});
});

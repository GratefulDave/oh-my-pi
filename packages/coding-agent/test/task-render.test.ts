/**
 * task/render — contract tests for TUI rendering of task tool calls and results.
 *
 * Covers:
 * - Async background card: "Running in background" label and job ID for details.async.state "running"
 * - Async background card: completed/failed state labels
 * - Foreground progress: reference disclosure glyph (▸ expand) and tree detail presence
 */

import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getThemeByName } from "../src/modes/theme/theme";
import { taskToolRenderer } from "../src/task/render";
import type { AgentProgress, TaskToolDetails } from "../src/task/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDarkTheme() {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme unavailable");
	return theme;
}

function makeMinimalProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "0-TestAgent",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do the work",
		assignment: "Complete the assignment",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeDetails(overrides: Partial<TaskToolDetails> = {}): TaskToolDetails {
	return {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Async background card
// ---------------------------------------------------------------------------

describe("task render: async background card", () => {
	it('includes "Running in background" text for state running', async () => {
		const theme = await getDarkTheme();
		const details = makeDetails({
			async: { state: "running", jobId: "bg-42", type: "task" },
		});
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain("Running in background");
	});

	it("includes the job ID in the running background card", async () => {
		const theme = await getDarkTheme();
		const jobId = "bg-job-99";
		const details = makeDetails({
			async: { state: "running", jobId, type: "task" },
		});
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain(jobId);
	});

	it('includes "Completed" label and job ID for state completed', async () => {
		const theme = await getDarkTheme();
		const jobId = "bg-done-7";
		const details = makeDetails({
			async: { state: "completed", jobId, type: "task" },
		});
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: false },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain("Completed");
		expect(rendered).toContain(jobId);
	});

	it('includes "Failed" label for state failed', async () => {
		const theme = await getDarkTheme();
		const details = makeDetails({
			async: { state: "failed", jobId: "bg-err-3", type: "task" },
		});
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: false },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain("Failed");
	});

	it("does not emit background card lines when async is absent", async () => {
		const theme = await getDarkTheme();
		const progress = makeMinimalProgress({ status: "running" });
		const details = makeDetails({ progress: [progress] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).not.toContain("Running in background");
	});
});

// ---------------------------------------------------------------------------
// Foreground progress — reference disclosure glyph and tree detail
// ---------------------------------------------------------------------------

describe("task render: foreground progress card", () => {
	it("renders the expand/disclosure glyph (nav.expand) on the agent header line", async () => {
		const theme = await getDarkTheme();
		const progress = makeMinimalProgress({ status: "running", description: "Auth refactor" });
		const details = makeDetails({ progress: [progress] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		// The nav.expand glyph (▸ or similar) appears on each agent header line.
		expect(rendered).toContain(theme.nav.expand);
	});

	it("renders the agent description in the progress card header", async () => {
		const theme = await getDarkTheme();
		const progress = makeMinimalProgress({ status: "running", description: "Lint the codebase" });
		const details = makeDetails({ progress: [progress] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain("Lint the codebase");
	});

	it("renders the formatted task ID in the progress card header", async () => {
		const theme = await getDarkTheme();
		const progress = makeMinimalProgress({
			id: "42-ReviewAgent",
			status: "running",
			description: "Review code",
		});
		const details = makeDetails({ progress: [progress] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		// formatTaskId strips the numeric prefix and renders the semantic part
		expect(rendered).toContain("ReviewAgent");
	});

	it("renders tree detail (hook glyph) when current tool is present", async () => {
		const theme = await getDarkTheme();
		const progress = makeMinimalProgress({
			status: "running",
			currentTool: "read",
			currentToolArgs: "src/main.ts",
		});
		const details = makeDetails({ progress: [progress] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		// tree.hook connects the tool detail line to the agent card
		expect(rendered).toContain(theme.tree.hook);
		expect(rendered).toContain("read");
	});

	it("renders multiple agents with tree connector glyphs between them", async () => {
		const theme = await getDarkTheme();
		const prog1 = makeMinimalProgress({ id: "1-A", status: "running", description: "Agent Alpha" });
		const prog2 = makeMinimalProgress({ id: "2-B", status: "running", description: "Agent Beta" });
		const details = makeDetails({ progress: [prog1, prog2] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		// Both agent headers carry the disclosure glyph
		const expandGlyph = theme.nav.expand;
		const count = rendered.split(expandGlyph).length - 1;
		expect(count).toBeGreaterThanOrEqual(2);
	});

	it("pending agent renders without stats section", async () => {
		const theme = await getDarkTheme();
		const progress = makeMinimalProgress({ status: "pending", description: "Queued agent" });
		const details = makeDetails({ progress: [progress] });
		const component = taskToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = sanitizeText(component.render(200).join("\n"));
		expect(rendered).toContain("Queued agent");
		// pending agents have no tool-use activity yet
		expect(rendered).not.toContain(theme.tree.hook);
	});
});

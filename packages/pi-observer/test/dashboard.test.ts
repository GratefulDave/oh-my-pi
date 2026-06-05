import { afterEach, describe, expect, test } from "bun:test";
import { ObserverDashboard } from "../src/dashboard";
import { stripAnsi } from "../src/renderer";
import { onSubagentProgress, resetStats } from "../src/stats-collector";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
	dim(text: string): string {
		return text;
	},
};

const dashboards: ObserverDashboard[] = [];

afterEach(() => {
	for (const dashboard of dashboards) dashboard.destroy();
	dashboards.length = 0;
	resetStats();
});

function makeDashboard(requestRender = () => {}, done = () => {}): ObserverDashboard {
	const dashboard = new ObserverDashboard(theme, requestRender, done);
	dashboards.push(dashboard);
	return dashboard;
}

function renderText(dashboard: ObserverDashboard): string {
	return dashboard.render(120, 50).map(stripAnsi).join("\n");
}

function seedAgents(): void {
	onSubagentProgress({
		id: "a",
		agent: "executor",
		status: "running",
		tokens: 1400,
		toolCount: 3,
		cost: 0.02,
		task: "Run A",
		assignment: "Implement dashboard hierarchy",
		currentTool: "edit",
		currentToolArgs: "dashboard.ts",
		recentOutput: ["patched hierarchy"],
		recentTools: [{ tool: "read", args: "dashboard.ts", endMs: 1 }],
	});
	onSubagentProgress({
		id: "b",
		agent: "reviewer",
		status: "completed",
		tokens: 1000,
		toolCount: 1,
		cost: 0.01,
		task: "Run B",
		recentOutput: ["review complete"],
	});
}

describe("ObserverDashboard", () => {
	test("root render starts at phase hierarchy instead of flat agent list", () => {
		seedAgents();
		const text = renderText(makeDashboard());

		expect(text).toContain("parity-distribution-diagnosis");
		expect(text).toContain("┌ Diagnose · 1 node ┬ Active diagnosis");
		expect(text).toContain("❯ ● Active diagnosis ›");
		expect(text).toContain("PHASE · Active diagnosis");
		expect(text).not.toContain("❯ ◌ Run A");
	});

	test("enter drills from phase into groups, agents, and agent detail nodes", () => {
		seedAgents();
		const dashboard = makeDashboard();

		expect(dashboard.act("enter")).toBe(true);
		let text = renderText(dashboard);
		expect(text).toContain("Active diagnosis · 5 nodes ┬ Agents");
		expect(text).toContain("❯ ● Agents ›");
		expect(text).toContain("GROUP · Agents");

		expect(dashboard.act("enter")).toBe(true);
		text = renderText(dashboard);
		expect(text).toContain("Active diagnosis · Agents · 2 nodes ┬ Run A");
		expect(text).toContain("❯ ◌ Run A ›");
		expect(text).toContain("AGENT · Run A");

		expect(dashboard.act("enter")).toBe(true);
		text = renderText(dashboard);
		expect(text).toContain("Active diagnosis · Agents · Run A · 4 nodes ┬ Prompt");
		expect(text).toContain("❯ ◌ Prompt");
		expect(text).toContain("PROMPT · Prompt");
	});

	test("escape backs up one hierarchy level before closing at root", () => {
		seedAgents();
		let closed = 0;
		const dashboard = makeDashboard(
			() => {},
			() => {
				closed++;
			},
		);
		dashboard.act("enter");
		dashboard.act("enter");
		expect(renderText(dashboard)).toContain("Active diagnosis · Agents · 2 nodes");

		expect(dashboard.act("escape")).toBe(true);
		expect(closed).toBe(0);
		expect(renderText(dashboard)).toContain("Active diagnosis · 5 nodes");

		expect(dashboard.act("escape")).toBe(true);
		expect(closed).toBe(0);
		expect(renderText(dashboard)).toContain("Diagnose · 1 node");

		expect(dashboard.act("escape")).toBe(true);
		expect(closed).toBe(1);
	});

	test("up and down move among siblings in current scope and preserve cursors", () => {
		seedAgents();
		let renders = 0;
		const dashboard = makeDashboard(() => {
			renders++;
		});
		dashboard.act("enter");

		expect(dashboard.act("down")).toBe(true);
		expect(renders).toBe(2);
		expect(renderText(dashboard)).toContain("Active diagnosis · 5 nodes ┬ Tasks");

		dashboard.act("up");
		expect(renderText(dashboard)).toContain("Active diagnosis · 5 nodes ┬ Agents");
		dashboard.act("enter");
		dashboard.act("down");
		expect(renderText(dashboard)).toContain("Active diagnosis · Agents · 2 nodes ┬ Run B");

		dashboard.act("escape");
		expect(renderText(dashboard)).toContain("Active diagnosis · 5 nodes ┬ Agents");
		dashboard.act("enter");
		expect(renderText(dashboard)).toContain("Active diagnosis · Agents · 2 nodes ┬ Run B");
	});

	test("leaf enter toggles expanded detail instead of drilling", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.act("enter");
		dashboard.act("enter");
		dashboard.act("enter");
		expect(renderText(dashboard)).toContain("Leaf · ↵ expand");
		dashboard.act("enter");
		expect(renderText(dashboard)).toContain("Expanded · ↵ collapse");
	});
});

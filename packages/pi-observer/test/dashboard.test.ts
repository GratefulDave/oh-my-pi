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
	test("root render uses observability language instead of diagnosis copy", () => {
		seedAgents();
		const text = renderText(makeDashboard());

		expect(text).toContain("session-observability");
		expect(text).toContain("Real-time agents, tasks, intercom, and metrics");
		expect(text).toContain("┌ Observability · 1 node ┬ Session observability [tree]");
		expect(text).toContain("❯ ● Session observability ›");
		expect(text).toContain("PHASE · Session observability");
		expect(text).not.toContain("Active diagnosis");
		expect(text).not.toContain("Diagnose");
		expect(text).not.toContain("❯ ◌ Run A");
	});

	test("raw terminal enter expands agents list before opening agent detail", () => {
		seedAgents();
		const dashboard = makeDashboard();

		dashboard.handleInput("\r");
		let text = renderText(dashboard);
		expect(text).toContain("Session observability · 3 nodes ┬ Agents [tree]");
		expect(text).toContain("❯ ● Agents ›");
		expect(text).toContain("PHASE · Session observability");

		dashboard.handleInput("\r");
		text = renderText(dashboard);
		expect(text).toContain("Session observability · Agents · 2 nodes ┬ Run A [tree]");
		expect(text).toContain("❯ ◌ Run A ›");
		expect(text).toContain("GROUP · Agents");
		expect(text).not.toContain("AGENT · Run A");

		dashboard.handleInput("\r");
		text = renderText(dashboard);
		expect(text).toContain("Session observability · Agents · Run A · 4 nodes ┬ Prompt [tree]");
		expect(text).toContain("❯ ◌ Prompt");
		expect(text).toContain("AGENT · Run A");
	});

	test("raw escape backs up hierarchy before closing overlay", () => {
		seedAgents();
		let closed = 0;
		const dashboard = makeDashboard(
			() => {},
			() => {
				closed++;
			},
		);
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("Session observability · Agents · 2 nodes");

		dashboard.handleInput("\x1b");
		expect(closed).toBe(0);
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes");

		dashboard.handleInput("\x1b");
		expect(closed).toBe(0);
		expect(renderText(dashboard)).toContain("Observability · 1 node");

		dashboard.handleInput("\x1b");
		expect(closed).toBe(1);
	});

	test("kitty escape sequence backs up and closes overlay", () => {
		seedAgents();
		let closed = 0;
		const dashboard = makeDashboard(
			() => {},
			() => {
				closed++;
			},
		);
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes");

		dashboard.handleInput("\x1b[27;1;27~");
		expect(closed).toBe(0);
		expect(renderText(dashboard)).toContain("Observability · 1 node");

		dashboard.handleInput("\x1b[27;1;27~");
		expect(closed).toBe(1);
	});

	test("raw arrow keys move among siblings in current scope and preserve cursors", () => {
		seedAgents();
		let renders = 0;
		const dashboard = makeDashboard(() => {
			renders++;
		});
		dashboard.handleInput("\r");

		dashboard.handleInput("\x1b[B");
		expect(renders).toBe(2);
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Intercom [tree]");

		dashboard.handleInput("\x1b[A");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Agents [tree]");
		dashboard.handleInput("\r");
		dashboard.handleInput("\x1b[B");
		expect(renderText(dashboard)).toContain("Session observability · Agents · 2 nodes ┬ Run B [tree]");

		dashboard.handleInput("\x1b");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Agents [tree]");
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("Session observability · Agents · 2 nodes ┬ Run B [tree]");
	});

	test("left and right arrow variants drill in and out of hierarchy", () => {
		seedAgents();
		const dashboard = makeDashboard();

		dashboard.handleInput("\x1b[1;1C");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Agents [tree]");
		dashboard.handleInput("\x1b[1;1C");
		expect(renderText(dashboard)).toContain("Session observability · Agents · 2 nodes ┬ Run A [tree]");
		dashboard.handleInput("\x1b[1;1D");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Agents [tree]");
		dashboard.handleInput("\x1bOD");
		expect(renderText(dashboard)).toContain("Observability · 1 node");
	});

	test("tab switches pane focus and escape still drills up", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Agents [tree]");

		dashboard.handleInput("\t");
		expect(renderText(dashboard)).toContain("Session observability · 3 nodes ┬ Agents [detail]");
		dashboard.handleInput("\x1b");
		expect(renderText(dashboard)).toContain("Observability · 1 node");
		expect(renderText(dashboard)).not.toContain("[detail]");
	});

	test("leaf enter opens expanded content in the right pane at the top", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("AGENT · Run A");
		dashboard.handleInput("\r");
		const text = renderText(dashboard);
		expect(text).toContain("PROMPT · Prompt");
		expect(text).toContain("Expanded · ↵ collapse");
		expect(text).toContain("[detail]");
		expect(text.indexOf("PROMPT · Prompt")).toBeLessThan(text.indexOf("Implement dashboard hierarchy"));
	});

	test("escape from expanded leaf closes right pane content before drilling up", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("PROMPT · Prompt");

		dashboard.handleInput("\x1b");
		let text = renderText(dashboard);
		expect(text).toContain("Session observability · Agents · Run A · 4 nodes ┬ Prompt [tree]");
		expect(text).toContain("AGENT · Run A");
		expect(text).not.toContain("PROMPT · Prompt");

		dashboard.handleInput("\x1b");
		text = renderText(dashboard);
		expect(text).toContain("Session observability · Agents · 2 nodes");
	});

	test("down on detail screen moves cursor without scrolling right pane header away", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		dashboard.handleInput("\r");
		expect(renderText(dashboard)).toContain("PROMPT · Prompt");

		dashboard.handleInput("\x1b[B");
		const text = renderText(dashboard);
		expect(text).toContain("Session observability · Agents · Run A · 4 nodes ┬ Tasks [detail]");
		expect(text).toContain("PROMPT · Prompt");
		expect(text).toContain("Expanded · ↵ collapse");
	});

	test("render uses supported theme palette colors for title, panes, and statuses", () => {
		seedAgents();
		const colors: string[] = [];
		const colored = new ObserverDashboard(
			{
				fg(color: string, text: string): string {
					colors.push(color);
					return text;
				},
				bold(text: string): string {
					return text;
				},
				dim(text: string): string {
					return text;
				},
			},
			() => {},
			() => {},
		);
		dashboards.push(colored);
		colored.render(120, 50);

		expect(colors).toContain("accent");
		expect(colors).toContain("border");
		expect(colors).toContain("borderAccent");
		expect(colors).toContain("toolOutput");
		expect(colors.every(color => color !== "cyan")).toBe(true);
	});

	test("depth 0 renders single list column with wide detail pane", () => {
		seedAgents();
		const dashboard = makeDashboard();
		const lines = dashboard.render(120, 50).map(stripAnsi);
		// At depth 0: 1 list col (32 wide) + detail col separated by exactly 1 ┴.
		const bottom = lines.find(l => l.startsWith("└")) ?? "";
		expect(bottom.split("┴").length - 1).toBe(1);
		// All body rows have the same total width.
		const rowWidths = lines.filter(l => l.startsWith("│")).map(l => l.length);
		expect(rowWidths.every(w => w === rowWidths[0])).toBe(true);
	});

	test("depth 1 renders two list columns", () => {
		seedAgents();
		const dashboard = makeDashboard();
		// Drill into Session observability → 2 list columns.
		dashboard.act("enter");
		const text = renderText(dashboard);
		const lines = dashboard.render(120, 50).map(stripAnsi);
		// Two ┴ separators in bottom border: col0 | col1 | detail.
		const bottom = lines.find(l => l.startsWith("└")) ?? "";
		expect(bottom.split("┴").length - 1).toBe(2);
		// Active column (col 1) shows phase children: Agents, Intercom, Metrics.
		// (Tasks/Activity are no longer flat top-level siblings — they live nested
		// under each agent so the drill-down reads Agents → agent → Tasks → …)
		expect(text).toContain("Agents");
		expect(text).toContain("Metrics");
		// Parent column (col 0) shows root list with Session observability highlighted.
		expect(text).toContain("Session observability");
	});

	test("depth 2 renders three list columns", () => {
		seedAgents();
		const dashboard = makeDashboard();
		// Drill twice: root → session → agents.
		dashboard.act("enter");
		dashboard.act("enter");
		const text = renderText(dashboard);
		const lines = dashboard.render(120, 50).map(stripAnsi);
		// Three ┴ separators: col0 | col1 | col2 | detail.
		const bottom = lines.find(l => l.startsWith("└")) ?? "";
		expect(bottom.split("┴").length - 1).toBe(3);
		// Rightmost column (active) shows agents: Run A, Run B.
		expect(text).toContain("Run A");
		expect(text).toContain("Run B");
		// Middle column shows phase groups (Agents, Intercom, Metrics).
		expect(text).toContain("Agents");
		expect(text).toContain("Metrics");
		// Title reflects current active scope (active = agents column).
		expect(text).toContain("Session observability · Agents · 2 nodes");
	});

	test("depth 3 still shows three list columns (root scrolls off) and full breadcrumb title", () => {
		seedAgents();
		const dashboard = makeDashboard();
		// Drill three times.
		dashboard.act("enter");
		dashboard.act("enter");
		dashboard.act("enter");
		const text = renderText(dashboard);
		const lines = dashboard.render(120, 50).map(stripAnsi);
		// Still exactly three ┴ separators — column count capped at MAX_LIST_COLUMNS.
		const bottom = lines.find(l => l.startsWith("└")) ?? "";
		expect(bottom.split("┴").length - 1).toBe(3);
		// Full breadcrumb still shown in title (not truncated at this width).
		expect(text).toContain("Session observability · Agents · Run A · 4 nodes");
		// Active column shows Run A's children.
		expect(text).toContain("Prompt");
	});

	test("column widths stay capped regardless of panel width", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.act("enter");
		dashboard.act("enter");
		// 3 columns at depth 2 on a very wide terminal.
		const lines = dashboard.render(300, 50).map(stripAnsi);
		const bottom = lines.find(l => l.startsWith("└")) ?? "";
		// Still 3 ┴ separators.
		expect(bottom.split("┴").length - 1).toBe(3);
		// Each list column is at most LEFT_COL_MAX_WIDTH=32 chars wide.
		// Bottom border: └─{w0}┴─{w1}┴─{w2}┴─{detail}┘
		const segments = bottom.slice(1, -1).split("┴");
		for (let i = 0; i < 3; i++) {
			expect((segments[i] ?? "").length).toBeLessThanOrEqual(32);
		}
	});

	test("back navigation reduces column count", () => {
		seedAgents();
		const dashboard = makeDashboard();
		dashboard.act("enter");
		dashboard.act("enter");
		// At depth 2 → 3 columns.
		expect(
			(
				dashboard
					.render(120, 50)
					.map(stripAnsi)
					.find(l => l.startsWith("└")) ?? ""
			).split("┴").length - 1,
		).toBe(3);

		// Back to depth 1 → 2 columns.
		dashboard.act("escape");
		expect(
			(
				dashboard
					.render(120, 50)
					.map(stripAnsi)
					.find(l => l.startsWith("└")) ?? ""
			).split("┴").length - 1,
		).toBe(2);

		// Back to depth 0 → 1 column.
		dashboard.act("escape");
		expect(
			(
				dashboard
					.render(120, 50)
					.map(stripAnsi)
					.find(l => l.startsWith("└")) ?? ""
			).split("┴").length - 1,
		).toBe(1);
	});

	test("parent columns highlight the drilled-into child, not cursor position", () => {
		seedAgents();
		const dashboard = makeDashboard();
		// Drill into session → agents (so col 0 = root, col 1 = phase children).
		dashboard.act("enter"); // into session
		dashboard.act("enter"); // into agents
		// Move cursor down in the active (agents) column.
		dashboard.act("down"); // move to Run B
		const text = renderText(dashboard);
		// Title shows Run B as selected (cursor moved).
		expect(text).toContain("Session observability · Agents · 2 nodes ┬ Run B");
		// Middle column (phase children) still highlights Agents — the drilled-into node.
		expect(text).toContain("❯ ● Agents ›");
	});
});

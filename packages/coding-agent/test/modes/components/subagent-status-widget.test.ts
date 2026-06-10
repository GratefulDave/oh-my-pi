import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { SubagentStatusWidget } from "../../../src/modes/components/subagent-status-widget";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { ObservableSession, SessionObserverRegistry } from "../../../src/modes/session-observer-registry";
import type { AgentSession } from "../../../src/session/agent-session";
import type { AgentProgress } from "../../../src/task";

function activeSession(id: string, overrides: Partial<ObservableSession> = {}): ObservableSession {
	const progress: AgentProgress = {
		index: 0,
		id,
		agent: "explore",
		agentSource: "bundled",
		status: "running",
		task: "Find TODO/FIXME comments",
		description: "Find TODO/FIXME comments",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 1700,
	};
	return {
		id,
		kind: "subagent",
		label: id,
		agent: "explore",
		description: "Find TODO/FIXME comments",
		status: "active",
		lastUpdate: 1_000,
		progress,
		...overrides,
	};
}

function renderWidget(sessions: ObservableSession[], queuedCount = 0, width = 120): string {
	const registry = { getSessions: () => sessions } as unknown as SessionObserverRegistry;
	const running = Array.from({ length: queuedCount }, (_, index) => ({
		id: `job-${index}`,
		type: "task" as const,
		status: "running" as const,
		label: `job ${index}`,
		startTime: 0,
		queued: true,
	}));
	const session = {
		getAsyncJobSnapshot: () => ({ running, recent: [], delivery: { delivered: [], pending: [] } }),
	} as unknown as AgentSession;
	return Bun.stripANSI(new SubagentStatusWidget(registry, session).render(width).join("\n"));
}

describe("SubagentStatusWidget", () => {
	beforeEach(async () => {
		const testTheme = await getThemeByName("dark");
		expect(testTheme).toBeDefined();
		setThemeInstance(testTheme!);
	});

	it("renders active subagents and queued task jobs", () => {
		vi.spyOn(Date, "now").mockReturnValue(2_700);
		const rendered = renderWidget(
			[
				activeSession("one", { lastUpdate: 1 }),
				activeSession("two", { lastUpdate: 2 }),
				activeSession("three", { lastUpdate: 3 }),
				activeSession("four", { lastUpdate: 4 }),
			],
			28,
		);

		expect(rendered).toContain("● Agents");
		expect(rendered).toContain("Explore  Find TODO/FIXME comments");
		expect(rendered).toContain("⎿  thinking…");
		expect(rendered).toContain("◦ 28 queued");
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sanitizes tabs in descriptions and activity", () => {
		vi.spyOn(Date, "now").mockReturnValue(2_700);
		const rendered = renderWidget(
			[
				activeSession("tabbed", {
					description: "Tabbed\tdescription that should be made safe before rendering",
					progress: {
						...activeSession("tabbed").progress!,
						description: "Tabbed\tdescription that should be made safe before rendering",
						recentOutput: ["tool\tactivity with a very long line that should be truncated before display"],
					},
				}),
			],
			0,
			50,
		);

		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("Tabbed");
		expect(rendered).toContain("tool");
	});

	it("renders empty state without rows", () => {
		vi.spyOn(Date, "now").mockReturnValue(2_700);
		expect(renderWidget([], 0)).toBe("");
	});
});







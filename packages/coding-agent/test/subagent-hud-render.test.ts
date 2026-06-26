/**
 * Contract: the anchored subagent HUD renders detached subagents exactly once,
 * groups them by agent source, keeps terminal rows visible, and self-clears when
 * no detached sessions remain.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		agent: "task",
		agentSource: "user",
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "user",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "user",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "user",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({
			id,
			index,
			description,
			task: description,
			currentTool: "read",
			lastIntent: "Scan file",
		}),
	};
}

function render(sessions: ObservableSession[], columns = 120): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns).join("\n"));
}

function renderRaw(sessions: ObservableSession[], columns = 120, spinnerFrame?: number): string {
	return renderSubagentHudLines(sessions, columns, spinnerFrame).join("\n");
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.shimmer": "disabled" } });
		await initTheme();
	});

	afterAll(() => resetSettingsForTest());

	it("renders one Agents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Review auth flow" }),
			makeSession({ id: "DocScout", agentSource: "bundled", description: "Inspect docs" }),
		]);
		expect((out.match(/agents/gi) ?? []).length).toBeGreaterThanOrEqual(1);
		// Header now uses renderStatusLine → "waiting on N agents" (accent colored, no bare "● Agents")
		expect(out).toContain("waiting on");
		expect(out).not.toContain("○ user");
		expect(out).not.toContain("○ bundled");
		expect(out).toContain("Review auth flow");
		expect(out).toContain("Inspect docs");
	});

	it("filters out non-detached spawns and self-clears when no detached sessions remain", () => {
		const sessions = [
			makeSession({ id: "SyncSpawn", detached: false, description: "inline task work" }),
			makeSession({ id: "EvalSpawn", detached: undefined, description: "eval task work" }),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);
		expect(
			renderSubagentHudLines(
				[{ id: "main", kind: "main", label: "Main", status: "active", lastUpdate: Date.now() }],
				120,
			),
		).toEqual([]);
	});

	it("keeps detached terminal rows visible after activity settles", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const sessions = [
			makeSession({
				id: "DoneWorker",
				status: "completed",
				description: undefined,
				progress: makeProgress({
					id: "DoneWorker",
					status: "completed",
					toolCount: 2,
					tokens: 1200,
					durationMs: 1400,
				}),
			}),
			makeSession({
				id: "FailedWorker",
				status: "failed",
				description: undefined,
				progress: makeProgress({
					id: "FailedWorker",
					status: "failed",
					toolCount: 3,
					tokens: 2400,
					durationMs: 2300,
				}),
			}),
		];
		const out = render(sessions);
		const rawOut = renderRaw(sessions);
		// All settled → header reads "N agents settled" (no "○ Agents" bare string)
		expect(out).toContain("agents settled");
		expect(out).toContain("DoneWorker");
		expect(out).toContain("FailedWorker");
		expect(rawOut).toContain(`${uiTheme!.getFgAnsi("accent")}[task]\x1b[39m`);
		expect(rawOut).toContain(`${uiTheme!.getFgAnsi("success")}2 tool uses\x1b[39m`);
		expect(rawOut).toContain(`${uiTheme!.getFgAnsi("error")}3 tool uses\x1b[39m`);
		expect(out).not.toContain("○ Agents");
	});

	it("uses progress snapshots for description and tool detail", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("FromProgress", 1, "Progress description", true),
		);

		const out = render(registry.getSessions());
		expect(out).not.toContain("○ user");
		expect(out).toContain("background work");
		expect(out).toContain("Progress description");
		expect(out).toContain("read");
		expect(out).toContain("Scan file");
	});

	it("colors active current-tool detail while processing", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const session = makeSession({
			id: "AuggieWorker",
			description: "Map HUD colors",
			progress: makeProgress({
				id: "AuggieWorker",
				status: "running",
				description: "Map HUD colors",
				currentTool: "mcp_auggie_codebase_retrieval",
				lastIntent: "Retrieving codebase context",
			}),
		});

		const raw = renderRaw([session], 180, 0);
		const stripped = Bun.stripANSI(raw);
		expect(raw).toContain(`${uiTheme!.getFgAnsi("accent")}mcp_auggie_codebase_retrieval\x1b[39m`);
		expect(stripped).toContain("waiting on 1 agent");
		expect(stripped).toContain("Map HUD colors");
		expect(stripped).toContain("mcp_auggie_codebase_retrieval");
		expect(raw).toContain(`${uiTheme!.getFgAnsi("dim")}Retrieving codebase context\x1b[39m`);
	});

	it("preserves stable order and caps to the latest six rows with a summary", () => {
		const sessions = Array.from({ length: 8 }, (_, index) =>
			makeSession({ id: `Worker${index + 1}`, description: undefined, index }),
		);
		const out = render(sessions, 90);
		expect(out).toContain("… 2 more agents");
		expect(out).not.toContain("Worker1");
		expect(out).not.toContain("Worker2");
		for (const id of ["Worker3", "Worker4", "Worker5", "Worker6", "Worker7", "Worker8"]) {
			expect(out).toContain(id);
		}
	});
});

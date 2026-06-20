/**
 * Contract: the anchored subagent HUD renders detached subagents exactly once,
 * groups them by agent source, keeps terminal rows visible, and self-clears when
 * no detached sessions remain.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
		progress: makeProgress({ id, index, description, task: description, currentTool: "read", lastIntent: "Scan file" }),
	};
}

function render(sessions: ObservableSession[], columns = 120): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns).join("\n"));
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders one Agents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Review auth flow" }),
			makeSession({ id: "DocScout", agentSource: "bundled", description: "Inspect docs" }),
		]);
		expect((out.match(/Agents/g) ?? []).length).toBe(1);
		expect(out).toContain("● Agents");
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
		expect(renderSubagentHudLines([{ id: "main", kind: "main", label: "Main", status: "active", lastUpdate: Date.now() }], 120)).toEqual([]);
	});

	it("keeps detached terminal rows visible after activity settles", () => {
		const out = render([
			makeSession({ id: "DoneWorker", status: "completed", description: undefined }),
			makeSession({ id: "FailedWorker", status: "failed", description: undefined }),
		]);
		expect(out).toContain("○ Agents");
		expect(out).toContain("DoneWorker");
		expect(out).toContain("FailedWorker");
	});

	it("uses progress snapshots for description and tool detail", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 1, "Progress description", true));

		const out = render(registry.getSessions());
		expect(out).not.toContain("○ user");
		expect(out).toContain("background work");
		expect(out).toContain("Progress description");
		expect(out).toContain("read");
		expect(out).toContain("Scan file");
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

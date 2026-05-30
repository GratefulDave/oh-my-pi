/**
 * SessionObserverRegistry — plugin bridge behavioral contract tests.
 *
 * Verifies that the registry correctly reflects subagent sessions surfaced via
 * both the native core EventBus channel (TASK_SUBAGENT_LIFECYCLE_CHANNEL) and
 * the plugin-emitted `subagents:*` channels from @gotgenes/pi-subagents.
 *
 * These tests define the contract that PluginBridgeCoreAgent must implement:
 * `subscribeToEventBus` must handle both channel families so that plugin-launched
 * subagents appear as read-only `ObservableSession` entries with `kind: "subagent"`.
 */

import { describe, expect, it } from "bun:test";
import { ASYNC_JOB_OBSERVER_CHANNEL, type AsyncJobObserverPayload } from "../src/async";
import { type ObservableSession, SessionObserverRegistry } from "../src/modes/session-observer-registry";
import {
	type AgentProgress,
	type AgentRunMetadata,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): { bus: EventBus; registry: SessionObserverRegistry } {
	const bus = new EventBus();
	const registry = new SessionObserverRegistry();
	registry.subscribeToEventBus(bus);
	return { bus, registry };
}

function subagentById(registry: SessionObserverRegistry, id: string): ObservableSession | undefined {
	return registry.getSessions().find(s => s.id === id);
}

// ---------------------------------------------------------------------------
// Core channel regression — TASK_SUBAGENT_LIFECYCLE_CHANNEL must still work
// after plugin subscriptions are wired up.
// ---------------------------------------------------------------------------

describe("core TASK_SUBAGENT_LIFECYCLE_CHANNEL (regression)", () => {
	it("creates an active subagent session on started lifecycle event", () => {
		const { bus, registry } = makeRegistry();

		const payload: SubagentLifecyclePayload = {
			id: "core-agent-1",
			agent: "task",
			agentSource: "bundled",
			description: "Core task agent",
			status: "started",
			index: 0,
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);

		const session = subagentById(registry, "core-agent-1");
		expect(session).toBeDefined();
		expect(session?.kind).toBe("subagent");
		expect(session?.status).toBe("active");
		expect(session?.description).toBe("Core task agent");
	});

	it("transitions status to completed on completed lifecycle event", () => {
		const { bus, registry } = makeRegistry();

		const startPayload: SubagentLifecyclePayload = {
			id: "core-agent-2",
			agent: "task",
			agentSource: "bundled",
			description: "Core task agent 2",
			status: "started",
			index: 1,
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, startPayload);

		const endPayload: SubagentLifecyclePayload = {
			...startPayload,
			status: "completed",
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, endPayload);

		const session = subagentById(registry, "core-agent-2");
		expect(session?.status).toBe("completed");
	});

	it("transitions status to failed on failed lifecycle event", () => {
		const { bus, registry } = makeRegistry();

		const startPayload: SubagentLifecyclePayload = {
			id: "core-agent-3",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 2,
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, startPayload);

		const failPayload: SubagentLifecyclePayload = {
			...startPayload,
			status: "failed",
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, failPayload);

		const session = subagentById(registry, "core-agent-3");
		expect(session?.status).toBe("failed");
	});

	it("persists sessionFile from lifecycle payload", () => {
		const { bus, registry } = makeRegistry();

		const payload: SubagentLifecyclePayload = {
			id: "core-agent-4",
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			index: 3,
			sessionFile: "/tmp/sessions/core-agent-4.jsonl",
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);

		const session = subagentById(registry, "core-agent-4");
		expect(session?.sessionFile).toBe("/tmp/sessions/core-agent-4.jsonl");
	});
});

// ---------------------------------------------------------------------------
// Plugin bridge — subagents:started
// ---------------------------------------------------------------------------

describe("plugin bridge: subagents:started", () => {
	it("creates an active subagent session with kind subagent", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-agent-1",
			type: "coder",
			description: "Refactor auth module",
		});

		const session = subagentById(registry, "plugin-agent-1");
		expect(session).toBeDefined();
		expect(session?.kind).toBe("subagent");
		expect(session?.status).toBe("active");
	});

	it("stores the agent type as the agent field", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-agent-2",
			type: "reviewer",
			description: "Code review pass",
		});

		const session = subagentById(registry, "plugin-agent-2");
		expect(session?.agent).toBe("reviewer");
	});

	it("stores description on the session", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-agent-3",
			type: "coder",
			description: "Write unit tests for parser",
		});

		const session = subagentById(registry, "plugin-agent-3");
		expect(session?.description).toBe("Write unit tests for parser");
	});

	it("notifies change listeners when session is created", () => {
		const { bus, registry } = makeRegistry();
		let notified = false;
		registry.onChange(() => {
			notified = true;
		});

		bus.emit("subagents:started", {
			id: "plugin-agent-notify",
			type: "coder",
			description: "Notify test",
		});

		expect(notified).toBe(true);
	});

	it("counts new plugin session in active subagent count", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-agent-count",
			type: "coder",
			description: "Count test agent",
		});

		expect(registry.getActiveSubagentCount()).toBe(1);
	});

	it("appears in active subagent descriptions", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-agent-desc",
			type: "coder",
			description: "Active description",
		});

		expect(registry.getActiveSubagentDescriptions()).toContain("Active description");
	});
});

// ---------------------------------------------------------------------------
// Plugin bridge — subagents:completed
// ---------------------------------------------------------------------------

describe("plugin bridge: subagents:completed", () => {
	it("transitions an existing session to completed", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-complete-1",
			type: "coder",
			description: "Auth refactor",
		});
		bus.emit("subagents:completed", {
			id: "plugin-complete-1",
			type: "coder",
			description: "Auth refactor",
			status: "done",
			result: "Refactored successfully",
			toolUses: 12,
			durationMs: 4500,
		});

		const session = subagentById(registry, "plugin-complete-1");
		expect(session?.status).toBe("completed");
	});

	it("creates a completed session even without a prior started event", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:completed", {
			id: "plugin-complete-orphan",
			type: "coder",
			description: "Orphaned completion",
			status: "done",
		});

		const session = subagentById(registry, "plugin-complete-orphan");
		expect(session).toBeDefined();
		expect(session?.status).toBe("completed");
		expect(session?.kind).toBe("subagent");
	});

	it("attaches transcript artifact ref when path is provided", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-complete-artifact",
			type: "coder",
			description: "Agent with artifacts",
		});
		bus.emit("subagents:completed", {
			id: "plugin-complete-artifact",
			type: "coder",
			description: "Agent with artifacts",
			status: "done",
			path: "/tmp/sessions/plugin-complete-artifact.jsonl",
		});

		const session = subagentById(registry, "plugin-complete-artifact");
		expect(session?.runMetadata?.artifacts).toBeDefined();
		const transcriptArtifact = session?.runMetadata?.artifacts.find(a => a.kind === "transcript");
		expect(transcriptArtifact).toBeDefined();
		expect(transcriptArtifact?.path).toBe("/tmp/sessions/plugin-complete-artifact.jsonl");
	});

	it("preserves plugin visible-pane presentation metadata when provided", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-visible-pane",
			type: "coder",
			description: "Visible pane agent",
			mode: "pane",
			backend: "tmux",
			session: "lex-subagents",
			paneId: "%42",
			command: ["lex", "--continue"],
			cwd: "/repo",
			worktree: "/repo/worktree",
		});

		const session = subagentById(registry, "plugin-visible-pane");
		expect(session?.runMetadata?.presentation).toEqual({
			mode: "pane",
			backend: "tmux",
			session: "lex-subagents",
			paneId: "%42",
			command: ["lex", "--continue"],
		});
		expect(session?.runMetadata?.cwd).toBe("/repo");
		expect(session?.runMetadata?.worktree).toBe("/repo/worktree");
	});

	it("leaves runMetadata.artifacts empty or undefined when no path provided", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:completed", {
			id: "plugin-complete-no-path",
			type: "coder",
			description: "No path agent",
			status: "done",
		});

		const session = subagentById(registry, "plugin-complete-no-path");
		// Either no runMetadata, or artifacts is empty — both are valid: no phantom refs.
		const artifacts = session?.runMetadata?.artifacts;
		expect(artifacts == null || artifacts.length === 0).toBe(true);
	});

	it("removes completed session from active descriptions", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-complete-2",
			type: "coder",
			description: "Completed agent",
		});
		bus.emit("subagents:completed", {
			id: "plugin-complete-2",
			type: "coder",
			description: "Completed agent",
			status: "done",
		});

		expect(registry.getActiveSubagentDescriptions()).not.toContain("Completed agent");
	});

	it("appears in completed subagent descriptions", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-complete-3",
			type: "coder",
			description: "Completed description agent",
		});
		bus.emit("subagents:completed", {
			id: "plugin-complete-3",
			type: "coder",
			description: "Completed description agent",
			status: "done",
		});

		expect(registry.getCompletedSubagentDescriptions()).toContain("Completed description agent");
	});
});

// ---------------------------------------------------------------------------
// Plugin bridge — subagents:failed
// ---------------------------------------------------------------------------

describe("plugin bridge: subagents:failed", () => {
	it("transitions an existing session to failed, not completed", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-fail-1",
			type: "coder",
			description: "Failing agent",
		});
		bus.emit("subagents:failed", {
			id: "plugin-fail-1",
			type: "coder",
			description: "Failing agent",
			status: "error",
			error: "Max turns exceeded",
		});

		const session = subagentById(registry, "plugin-fail-1");
		expect(session?.status).toBe("failed");
		expect(session?.status).not.toBe("completed");
	});

	it("creates a failed session when started event was missed", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:failed", {
			id: "plugin-fail-orphan",
			type: "coder",
			description: "Orphaned failure",
			status: "error",
			error: "Unexpected crash",
		});

		const session = subagentById(registry, "plugin-fail-orphan");
		expect(session).toBeDefined();
		expect(session?.status).toBe("failed");
		expect(session?.kind).toBe("subagent");
	});

	it("does not count failed sessions in active subagent count", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-fail-count",
			type: "coder",
			description: "Failing agent count test",
		});
		expect(registry.getActiveSubagentCount()).toBe(1);

		bus.emit("subagents:failed", {
			id: "plugin-fail-count",
			type: "coder",
			description: "Failing agent count test",
			status: "error",
		});
		expect(registry.getActiveSubagentCount()).toBe(0);
	});

	it("does not treat failed sessions as completed", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:failed", {
			id: "plugin-fail-not-complete",
			type: "coder",
			description: "Failed not completed",
			status: "stopped",
		});

		expect(registry.getCompletedSubagentDescriptions()).not.toContain("Failed not completed");
	});
});

// ---------------------------------------------------------------------------
// Isolation — plugin events do not interfere with core channel sessions
// ---------------------------------------------------------------------------

describe("isolation: plugin and core channels coexist", () => {
	it("handles concurrent core and plugin sessions independently", () => {
		const { bus, registry } = makeRegistry();

		// Core channel session
		const corePayload: SubagentLifecyclePayload = {
			id: "coexist-core",
			agent: "task",
			agentSource: "bundled",
			description: "Core session",
			status: "started",
			index: 0,
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, corePayload);

		// Plugin channel session
		bus.emit("subagents:started", {
			id: "coexist-plugin",
			type: "coder",
			description: "Plugin session",
		});

		const sessions = registry.getSessions();
		const coreSession = sessions.find(s => s.id === "coexist-core");
		const pluginSession = sessions.find(s => s.id === "coexist-plugin");

		expect(coreSession?.status).toBe("active");
		expect(pluginSession?.status).toBe("active");
		expect(registry.getActiveSubagentCount()).toBe(2);
	});

	it("completing a plugin session does not affect core session status", () => {
		const { bus, registry } = makeRegistry();

		const corePayload: SubagentLifecyclePayload = {
			id: "isolate-core",
			agent: "task",
			agentSource: "bundled",
			description: "Core stays active",
			status: "started",
			index: 0,
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, corePayload);

		bus.emit("subagents:started", {
			id: "isolate-plugin",
			type: "coder",
			description: "Plugin completes",
		});
		bus.emit("subagents:completed", {
			id: "isolate-plugin",
			type: "coder",
			description: "Plugin completes",
			status: "done",
		});

		const coreSession = subagentById(registry, "isolate-core");
		const pluginSession = subagentById(registry, "isolate-plugin");

		expect(coreSession?.status).toBe("active");
		expect(pluginSession?.status).toBe("completed");
	});

	it("resetSessions clears both core and plugin sessions", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "reset-core",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		bus.emit("subagents:started", {
			id: "reset-plugin",
			type: "coder",
			description: "Plugin session to reset",
		});

		registry.resetSessions();

		expect(registry.getSessions()).toHaveLength(0);
	});

	it("subscribeToEventBus re-subscription replaces plugin subscriptions (no double-fire)", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();

		// Subscribe twice — second call must dispose the first subscriptions.
		registry.subscribeToEventBus(bus);
		registry.subscribeToEventBus(bus);

		bus.emit("subagents:started", {
			id: "dedup-plugin",
			type: "coder",
			description: "Dedup test",
		});

		// Session must appear exactly once, not twice.
		const sessions = registry.getSessions().filter(s => s.id === "dedup-plugin");
		expect(sessions).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Dispose — subscriptions and sessions are cleaned up
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Async job bridge — AsyncJobManager observer channel
// ---------------------------------------------------------------------------

describe("async job bridge: async background jobs", () => {
	it("creates active bash job sessions with stable job-prefixed ids", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "bg_1",
			type: "bash",
			label: "Long bash command",
			status: "running",
			startTime: 123,
			ownerId: "0-Main",
		} satisfies AsyncJobObserverPayload);

		const session = subagentById(registry, "job:bg_1");
		expect(session).toBeDefined();
		expect(session?.kind).toBe("subagent");
		expect(session?.agent).toBe("bash");
		expect(session?.label).toBe("Long bash command");
		expect(session?.status).toBe("active");
		expect(session?.source).toEqual({
			kind: "async-job",
			name: "AsyncJobManager",
			eventChannel: ASYNC_JOB_OBSERVER_CHANNEL,
			ownerId: "0-Main",
			jobType: "bash",
		});
		expect(session?.runMetadata).toMatchObject({
			runId: "bg_1",
			taskId: "bg_1",
			agent: "bash",
			status: "running",
			presentation: { mode: "embedded", backend: "core" },
			artifacts: [],
		});
		expect(session?.sessionFile).toBeUndefined();
	});

	it("reflects bash progress text without inventing transcript artifacts", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "bg_progress",
			type: "bash",
			label: "tail build",
			status: "running",
			startTime: 123,
		} satisfies AsyncJobObserverPayload);
		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "bg_progress",
			type: "bash",
			label: "tail build",
			status: "running",
			startTime: 123,
			progressText: "compiled 42 files",
			progressDetails: { async: { state: "running", jobId: "bg_progress", type: "bash" } },
		} satisfies AsyncJobObserverPayload);

		const session = subagentById(registry, "job:bg_progress");
		expect(session?.description).toBe("compiled 42 files");
		expect(session?.status).toBe("active");
		expect(session?.runMetadata?.artifacts).toEqual([]);
	});

	it("maps completed, failed, and cancelled job statuses consistently", () => {
		const { bus, registry } = makeRegistry();

		for (const status of ["completed", "failed", "cancelled"] as const) {
			bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
				id: `bg_${status}`,
				type: "bash",
				label: status,
				status,
				startTime: 123,
				resultText: status === "completed" ? "ok" : undefined,
				errorText: status === "failed" ? "boom" : undefined,
			} satisfies AsyncJobObserverPayload);
		}

		expect(subagentById(registry, "job:bg_completed")?.status).toBe("completed");
		expect(subagentById(registry, "job:bg_completed")?.runMetadata?.status).toBe("completed");
		expect(subagentById(registry, "job:bg_failed")?.status).toBe("failed");
		expect(subagentById(registry, "job:bg_failed")?.runMetadata?.status).toBe("failed");
		expect(subagentById(registry, "job:bg_cancelled")?.status).toBe("aborted");
		expect(subagentById(registry, "job:bg_cancelled")?.runMetadata?.status).toBe("aborted");
	});

	it("preserves task job progress and run metadata from async details", () => {
		const { bus, registry } = makeRegistry();
		const runMetadata: AgentRunMetadata = {
			runId: "task_job_1",
			taskId: "task-1",
			agent: "reviewer",
			cwd: "/repo",
			status: "running",
			presentation: { mode: "pane", backend: "core", paneId: "pane-1" },
			artifacts: [{ kind: "transcript", path: "/tmp/task_job_1.jsonl" }],
		};
		const progress: AgentProgress = {
			index: 0,
			id: "task-1",
			agent: "reviewer",
			agentSource: "bundled",
			status: "running",
			task: "review code",
			assignment: "review code",
			description: "Review agent",
			recentTools: [],
			recentOutput: ["started"],
			toolCount: 1,
			tokens: 10,
			cost: 0.01,
			durationMs: 250,
			runMetadata,
		};

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "task_job_1",
			type: "task",
			label: "background reviewer",
			status: "running",
			startTime: 123,
			progressText: "reviewing",
			progressDetails: {
				progress: [progress],
				async: { state: "running", jobId: "task_job_1", type: "task" },
			},
		} satisfies AsyncJobObserverPayload);

		const session = subagentById(registry, "job:task_job_1");
		expect(session?.progress).toEqual(progress);
		expect(session?.runMetadata).toEqual(runMetadata);
		expect(session?.description).toBe("Review agent");
		expect(session?.source?.jobType).toBe("task");
	});
});

describe("dispose", () => {
	it("stops reacting to plugin events after dispose", () => {
		const { bus, registry } = makeRegistry();

		registry.dispose();

		bus.emit("subagents:started", {
			id: "after-dispose",
			type: "coder",
			description: "Should not appear",
		});

		// No sessions: dispose cleared the sessions map and handlers.
		expect(registry.getSessions()).toHaveLength(0);
	});

	it("stops reacting to core events after dispose", () => {
		const { bus, registry } = makeRegistry();

		registry.dispose();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "after-dispose-core",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSessions()).toHaveLength(0);
	});
});

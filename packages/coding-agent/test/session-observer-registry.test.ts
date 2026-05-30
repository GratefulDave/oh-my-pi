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
import type { CustomMessage } from "../src/session/messages";
import {
	type AgentProgress,
	type AgentRunMetadata,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
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

it("preserves native run metadata from lifecycle and progress events", () => {
	const { bus, registry } = makeRegistry();
	const runMetadata: AgentRunMetadata = {
		runId: "core-agent-meta",
		taskId: "task-meta",
		agent: "task",
		cwd: "/repo",
		status: "running",
		presentation: { mode: "embedded", backend: "core" },
		artifacts: [{ kind: "transcript", path: "/tmp/core-agent-meta.jsonl" }],
	};
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "core-agent-meta",
		agent: "task",
		agentSource: "bundled",
		description: "Native task agent",
		status: "started",
		index: 4,
		runMetadata,
	} satisfies SubagentLifecyclePayload);

	const running = subagentById(registry, "core-agent-meta");
	expect(running?.runMetadata).toEqual(runMetadata);
	expect(running?.status).toBe("active");

	const progress: AgentProgress = {
		index: 4,
		id: "core-agent-meta",
		agent: "task",
		agentSource: "bundled",
		status: "completed",
		task: "native task",
		description: "Native task completed",
		recentTools: [],
		recentOutput: ["done"],
		toolCount: 1,
		tokens: 10,
		cost: 0,
		durationMs: 25,
		runMetadata: { ...runMetadata, status: "completed" },
	};
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
		index: 4,
		agent: "task",
		agentSource: "bundled",
		task: "native task",
		progress,
		runMetadata: progress.runMetadata,
	});

	const completed = subagentById(registry, "core-agent-meta");
	expect(completed?.status).toBe("completed");
	expect(completed?.label).toBe("Native task completed");
	expect(completed?.progress).toEqual(progress);
	expect(completed?.runMetadata?.status).toBe("completed");
});

describe("IRC conversation rows", () => {
	it("records relay messages as directional conversation rows", () => {
		const registry = new SessionObserverRegistry();

		registry.recordIrcMessage({
			role: "custom",
			customType: "irc:relay",
			content: "[IRC `A` → `B`]\n\nNeed ownership?",
			display: true,
			details: { from: "A", to: "B", body: "Need ownership?", kind: "message" },
			timestamp: 10,
		} satisfies CustomMessage);
		registry.recordIrcMessage({
			role: "custom",
			customType: "irc:relay",
			content: "[IRC `B` → (auto) `A`]\n\nTake it.",
			display: true,
			details: { from: "B", to: "A", body: "Take it.", kind: "reply" },
			timestamp: 11,
		} satisfies CustomMessage);

		expect(registry.getIrcConversationRows()).toEqual([
			{
				id: "irc:relay:A:B:10:Need ownership?",
				from: "A",
				to: "B",
				body: "Need ownership?",
				kind: "message",
				timestamp: 10,
			},
			{
				id: "irc:relay:B:A:11:Take it.",
				from: "B",
				to: "A",
				body: "Take it.",
				kind: "reply",
				timestamp: 11,
			},
		]);
	});

	it("deduplicates repeated IRC event delivery", () => {
		const registry = new SessionObserverRegistry();
		const message = {
			role: "custom",
			customType: "irc:relay",
			content: "Body",
			display: true,
			details: { from: "A", to: "B", body: "Body", kind: "message" },
			timestamp: 12,
		} satisfies CustomMessage;

		registry.recordIrcMessage(message);
		registry.recordIrcMessage(message);

		expect(registry.getIrcConversationRows()).toHaveLength(1);
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

	it("surfaces real cmux pane and window presentation metadata from plugin payloads", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "plugin-cmux-pane",
			type: "coder",
			description: "Visible cmux agent",
			mode: "window",
			backend: "cmux",
			session: "cmux-session-1",
			paneId: "pane-1",
			windowId: "window-1",
			command: ["cmux", "new-split", "right"],
		});

		const session = subagentById(registry, "plugin-cmux-pane");
		expect(session?.runMetadata?.presentation).toEqual({
			mode: "window",
			backend: "cmux",
			session: "cmux-session-1",
			paneId: "pane-1",
			windowId: "window-1",
			command: ["cmux", "new-split", "right"],
		});
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

	it("stores bash progress on the async job payload without replacing the command label", () => {
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
		expect(session?.label).toBe("tail build");
		expect(session?.description).toBeUndefined();
		expect(session?.asyncJob?.progressText).toBe("compiled 42 files");
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

// ---------------------------------------------------------------------------
// Auto-open gating — shouldAutoOpen fires once per activity burst
// ---------------------------------------------------------------------------

describe("auto-open gating", () => {
	it("returns false when no active subagents exist", () => {
		const { registry } = makeRegistry();
		expect(registry.shouldAutoOpen()).toBe(false);
	});

	it("returns true the first time an active subagent appears", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "auto-open-1",
			agent: "task",
			agentSource: "bundled",
			description: "First task",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		expect(registry.shouldAutoOpen()).toBe(true);
	});

	it("returns false on subsequent calls after the first auto-open", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "auto-open-2",
			agent: "task",
			agentSource: "bundled",
			description: "Task A",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		expect(registry.shouldAutoOpen()).toBe(true);
		// Second subagent arrives — should not re-trigger
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "auto-open-3",
			agent: "task",
			agentSource: "bundled",
			description: "Task B",
			status: "started",
			index: 1,
		} satisfies SubagentLifecyclePayload);

		expect(registry.shouldAutoOpen()).toBe(false);
	});

	it("re-arms after resetAutoOpen so a new burst can trigger", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "auto-open-4",
			agent: "task",
			agentSource: "bundled",
			description: "Burst 1",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		expect(registry.shouldAutoOpen()).toBe(true);

		// Simulate session switch
		registry.resetSessions();
		registry.resetAutoOpen();

		// New activity after reset
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "auto-open-5",
			agent: "task",
			agentSource: "bundled",
			description: "Burst 2",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		expect(registry.shouldAutoOpen()).toBe(true);
	});

	it("fires for async job activations, not only lifecycle events", () => {
		const { bus, registry } = makeRegistry();

		const jobPayload: AsyncJobObserverPayload = {
			id: "job-auto-1",
			type: "bash",
			label: "Async bash job",
			status: "running",
			startTime: Date.now(),
		};
		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, jobPayload);

		expect(registry.shouldAutoOpen()).toBe(true);
		// Still one-shot
		expect(registry.shouldAutoOpen()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getActiveMuxSession — mux routing helper
// ---------------------------------------------------------------------------

describe("getActiveMuxSession", () => {
	it("returns undefined when registry is empty", () => {
		const { registry } = makeRegistry();
		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("returns undefined when only the main session exists", () => {
		const { registry } = makeRegistry();
		registry.setMainSession();
		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("returns undefined when only core-backend subagent sessions exist", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "core-sub-1",
			type: "coder",
			description: "Core-backend agent",
			mode: "embedded",
			backend: "core",
		});

		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("returns undefined when only acpx-backend subagent sessions exist", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "acpx-sub-1",
			type: "coder",
			description: "ACPX agent",
			mode: "embedded",
			backend: "acpx",
		});

		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("returns undefined when only sessions with no backend metadata exist", () => {
		const { bus, registry } = makeRegistry();

		const payload: SubagentLifecyclePayload = {
			id: "no-meta-1",
			agent: "task",
			agentSource: "bundled",
			description: "No metadata subagent",
			index: 0,
			status: "started",
		};
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);

		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("returns the active tmux session", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "tmux-sub-1",
			type: "coder",
			description: "tmux worker",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});

		const result = registry.getActiveMuxSession();
		expect(result).toBeDefined();
		expect(result?.id).toBe("tmux-sub-1");
		expect(result?.runMetadata?.presentation.backend).toBe("tmux");
	});

	it("returns the active cmux session", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "cmux-sub-1",
			type: "coder",
			description: "cmux worker",
			mode: "window",
			backend: "cmux",
			session: "cmux-main",
		});

		const result = registry.getActiveMuxSession();
		expect(result).toBeDefined();
		expect(result?.id).toBe("cmux-sub-1");
		expect(result?.runMetadata?.presentation.backend).toBe("cmux");
	});

	it("returns the most recently updated mux session when multiple are active", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "tmux-a",
			type: "coder",
			description: "First tmux worker",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});

		bus.emit("subagents:started", {
			id: "cmux-b",
			type: "coder",
			description: "Second cmux worker",
			mode: "window",
			backend: "cmux",
			session: "cmux-main",
		});

		// Pin lastUpdate so we own the ordering, regardless of Date.now() resolution.
		const sessions = registry.getSessions();
		const a = sessions.find(s => s.id === "tmux-a");
		const b = sessions.find(s => s.id === "cmux-b");
		if (!a || !b) throw new Error("sessions not found");
		a.lastUpdate = 1000;
		b.lastUpdate = 2000; // cmux-b is the most recent

		expect(registry.getActiveMuxSession()?.id).toBe("cmux-b");

		// Flip: make tmux-a the most recent
		a.lastUpdate = 3000;
		expect(registry.getActiveMuxSession()?.id).toBe("tmux-a");
	});

	it("ignores completed tmux sessions", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "tmux-done",
			type: "coder",
			description: "Completed tmux worker",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});
		bus.emit("subagents:completed", {
			id: "tmux-done",
			type: "coder",
			description: "Completed tmux worker",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});

		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("ignores failed cmux sessions", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "cmux-failed",
			type: "coder",
			description: "Failed cmux worker",
			mode: "window",
			backend: "cmux",
			session: "cmux-main",
		});
		bus.emit("subagents:failed", {
			id: "cmux-failed",
			type: "coder",
			description: "Failed cmux worker",
			mode: "window",
			backend: "cmux",
			session: "cmux-main",
		});

		expect(registry.getActiveMuxSession()).toBeUndefined();
	});

	it("returns active mux session even when non-mux sessions also exist", () => {
		const { bus, registry } = makeRegistry();

		registry.setMainSession();

		bus.emit("subagents:started", {
			id: "core-sub",
			type: "coder",
			description: "Core-backend agent",
			mode: "embedded",
			backend: "core",
		});

		bus.emit("subagents:started", {
			id: "tmux-active",
			type: "coder",
			description: "Active tmux agent",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});

		const result = registry.getActiveMuxSession();
		expect(result?.id).toBe("tmux-active");
	});

	it("returns undefined after all mux sessions are completed", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "tmux-final",
			type: "coder",
			description: "tmux worker",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});
		expect(registry.getActiveMuxSession()).toBeDefined();

		bus.emit("subagents:completed", {
			id: "tmux-final",
			type: "coder",
			description: "tmux worker",
			mode: "window",
			backend: "tmux",
			session: "tmux-main",
		});
		expect(registry.getActiveMuxSession()).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getObserverRows — normalized row model contract
// ---------------------------------------------------------------------------

describe("getObserverRows — source normalization contract", () => {
	it("excludes the main session", () => {
		const { registry } = makeRegistry();
		registry.setMainSession();
		const rows = registry.getObserverRows();
		expect(rows.every(r => r.session.kind !== "main")).toBe(true);
	});

	it("orders active rows first, then inactive, each by lastUpdate desc", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "row-completed-old",
			agent: "task",
			agentSource: "bundled",
			description: "Old completed",
			status: "completed",
			index: 0,
		} satisfies SubagentLifecyclePayload);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "row-active",
			agent: "task",
			agentSource: "bundled",
			description: "Active agent",
			status: "started",
			index: 1,
		} satisfies SubagentLifecyclePayload);

		const rows = registry.getObserverRows();
		expect(rows[0]?.id).toBe("row-active");
		expect(rows[1]?.id).toBe("row-completed-old");
	});

	it("(a) core lifecycle event — normalizes Agent/Task/Status/Message correctly", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "row-core-lifecycle",
			agent: "explore",
			agentSource: "bundled",
			description: "Analyze git history",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		const rows = registry.getObserverRows();
		const row = rows.find(r => r.id === "row-core-lifecycle");
		expect(row).toBeDefined();
		expect(row?.agent).toBe("explore");
		expect(row?.task).toBe("Analyze git history");
		expect(row?.status).toBe("running");
		expect(row?.message).toBe("thinking…");
		expect(row?.session.id).toBe("row-core-lifecycle");
	});

	it("(a) core lifecycle completed — status is completed, message is empty", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "row-core-done",
			agent: "task",
			agentSource: "bundled",
			description: "Finished work",
			status: "completed",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		const row = registry.getObserverRows().find(r => r.id === "row-core-done");
		expect(row?.status).toBe("completed");
		expect(row?.message).toBe("");
	});

	it("(a) core aborted lifecycle — status is cancelled", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "row-core-abort",
			agent: "task",
			agentSource: "bundled",
			description: "Aborted work",
			status: "aborted",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		const row = registry.getObserverRows().find(r => r.id === "row-core-abort");
		expect(row?.status).toBe("cancelled");
	});

	it("(b) async bash job — normalizes Agent/Task/Status/Message", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "row-bash-1",
			type: "bash",
			label: "tail -f build.log",
			status: "running",
			startTime: Date.now(),
			progressText: "compiled 10 files",
		} satisfies AsyncJobObserverPayload);

		const row = registry.getObserverRows().find(r => r.id === "job:row-bash-1");
		expect(row).toBeDefined();
		expect(row?.agent).toBe("bash");
		expect(row?.task).toBe("tail -f build.log");
		expect(row?.status).toBe("running");
		// progressText first line as message (no progress/lastIntent/currentTool)
		expect(row?.message).toBe("compiled 10 files");
	});

	it("(b) async bash job cancelled — status is cancelled", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "row-bash-cancel",
			type: "bash",
			label: "long command",
			status: "cancelled",
			startTime: Date.now(),
		} satisfies AsyncJobObserverPayload);

		const row = registry.getObserverRows().find(r => r.id === "job:row-bash-cancel");
		expect(row?.status).toBe("cancelled");
	});

	it("(c) async task job with progress — uses progress fields for Agent/Task/Message", () => {
		const { bus, registry } = makeRegistry();
		const runMetadata: AgentRunMetadata = {
			runId: "row-task-job",
			taskId: "row-task-job",
			agent: "reviewer",
			cwd: "/repo",
			status: "running",
			presentation: { mode: "embedded", backend: "core" },
			artifacts: [],
		};
		const progress: AgentProgress = {
			index: 0,
			id: "row-task-job",
			agent: "reviewer",
			agentSource: "bundled",
			status: "running",
			task: "review code",
			assignment: "review all the code",
			description: "Reviewer agent task",
			lastIntent: "Reading source files",
			recentTools: [],
			recentOutput: ["started analysis"],
			toolCount: 2,
			tokens: 500,
			cost: 0.01,
			durationMs: 300,
			runMetadata,
		};

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "row-task-job",
			type: "task",
			label: "background reviewer",
			status: "running",
			startTime: Date.now(),
			progressText: "reviewing",
			progressDetails: {
				progress: [progress],
				async: { state: "running", jobId: "row-task-job", type: "task" },
			},
		} satisfies AsyncJobObserverPayload);

		const row = registry.getObserverRows().find(r => r.id === "job:row-task-job");
		expect(row).toBeDefined();
		// Agent from session.agent = payload.type = "task" (job type, takes precedence over progress.runMetadata.agent)
		expect(row?.agent).toBe("task");
		// Task from progress.description (preferred over asyncJob.label)
		expect(row?.task).toBe("Reviewer agent task");
		expect(row?.status).toBe("running");
		// Message from progress.lastIntent (highest priority)
		expect(row?.message).toBe("Reading source files");
	});

	it("(c) async task job progress pending — status is queued", () => {
		const { bus, registry } = makeRegistry();
		const progress: AgentProgress = {
			index: 0,
			id: "row-task-pending",
			agent: "task",
			agentSource: "bundled",
			status: "pending",
			task: "pending work",
			assignment: "do pending work",
			description: "Pending agent",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "row-task-pending",
			type: "task",
			label: "pending task job",
			status: "running",
			startTime: Date.now(),
			progressDetails: {
				progress: [progress],
				async: { state: "running", jobId: "row-task-pending", type: "task" },
			},
		} satisfies AsyncJobObserverPayload);

		const row = registry.getObserverRows().find(r => r.id === "job:row-task-pending");
		expect(row?.status).toBe("queued");
	});

	it("(d) plugin started event — normalizes Agent/Task/Status/Message (no message field)", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "row-plugin-start",
			type: "coder",
			description: "Refactor auth module",
		});

		const row = registry.getObserverRows().find(r => r.id === "row-plugin-start");
		expect(row).toBeDefined();
		expect(row?.agent).toBe("coder");
		expect(row?.task).toBe("Refactor auth module");
		expect(row?.status).toBe("running");
		expect(row?.message).toBe("thinking…");
	});

	it("(d) plugin completed with result field — message derives from result", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:completed", {
			id: "row-plugin-result",
			type: "coder",
			description: "Code review",
			result: "All tests pass",
		});

		const row = registry.getObserverRows().find(r => r.id === "row-plugin-result");
		expect(row?.status).toBe("completed");
		expect(row?.message).toBe("All tests pass");
	});

	it("(d) plugin failed with error field — message derives from error", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:failed", {
			id: "row-plugin-error",
			type: "coder",
			description: "Failing agent",
			error: "Max turns exceeded",
		});

		const row = registry.getObserverRows().find(r => r.id === "row-plugin-error");
		expect(row?.status).toBe("failed");
		expect(row?.message).toBe("Max turns exceeded");
	});

	it("(d) plugin event with message field — message field takes highest priority", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "row-plugin-msg",
			type: "coder",
			description: "Agent with message",
			message: "Initializing workspace",
			error: "should not use this",
		});

		const row = registry.getObserverRows().find(r => r.id === "row-plugin-msg");
		expect(row?.message).toBe("Initializing workspace");
	});

	it("(d) plugin event with statusMessage — used when message absent", () => {
		const { bus, registry } = makeRegistry();

		bus.emit("subagents:started", {
			id: "row-plugin-statusmsg",
			type: "coder",
			description: "Agent with statusMessage",
			statusMessage: "Running tests",
		});

		const row = registry.getObserverRows().find(r => r.id === "row-plugin-statusmsg");
		expect(row?.message).toBe("Running tests");
	});

	it("row.session holds the backing ObservableSession", () => {
		const { bus, registry } = makeRegistry();

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "row-session-ref",
			agent: "task",
			agentSource: "bundled",
			description: "Session ref test",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		const row = registry.getObserverRows().find(r => r.id === "row-session-ref");
		expect(row?.session).toBeDefined();
		expect(row?.session.id).toBe("row-session-ref");
		expect(row?.session.kind).toBe("subagent");
	});
});

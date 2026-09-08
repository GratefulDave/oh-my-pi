import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Parent `agent_end` must not look terminal to extension hosts while a
 * spawned subagent is still `running`. ctx.isIdle() follows the same rule so
 * every profile's reporter sees working, not the parent's loop settle.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession parent idle vs live subagents", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let extensionEmit = vi.fn().mockResolvedValue(undefined);
	let emitSessionStop = vi.fn().mockResolvedValue(undefined);
	let hasHandlers = vi.fn((_eventType?: string) => false);
	let agentEndTerminalStates: Array<boolean | undefined>;
	let manager: AsyncJobManager | undefined;
	const gates: Array<PromiseWithResolvers<string>> = [];

	function textOnlyAssistantMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "waiting on children" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(target = session): void {
		const msg = textOnlyAssistantMessage();
		target.agent.emitExternalEvent({ type: "message_end", message: msg });
		target.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function registerChild(id: string, parentId: string, status: "running" | "idle" | "parked" = "running"): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId,
			session: null,
			status,
		});
	}

	async function flushExtensionLifecycle(): Promise<void> {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	}

	function createSession(opts?: {
		agentId?: string;
		agentKind?: "main" | "sub";
		asyncJobs?: boolean;
		agentRegistry?: AgentRegistry;
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		extensionEmit = vi.fn().mockResolvedValue(undefined);
		emitSessionStop = vi.fn().mockResolvedValue(undefined);
		hasHandlers = vi.fn((eventType?: string) => eventType === "session_stop");
		if (opts?.asyncJobs) {
			manager = new AsyncJobManager({});
		}
		const next = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: sharedModelRegistry,
			agentId: opts?.agentId ?? "Main",
			agentKind: opts?.agentKind ?? "main",
			agentRegistry: opts?.agentRegistry,
			asyncJobManager: manager,
			extensionRunner: {
				emit: extensionEmit,
				emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
				hasHandlers,
				emitSessionStop,
			} as unknown as ExtensionRunner,
		});
		if (manager) {
			manager.registerDeliverySink(opts?.agentId ?? "Main", () => {});
		}
		return next;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-parent-subagent-idle-");
		gates.length = 0;
		manager = undefined;
		session = createSession();
		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") {
				agentEndTerminalStates.push(event.isTerminal);
			}
		});
	});

	afterEach(async () => {
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		if (manager) {
			manager.cancelAll();
			await manager.dispose();
		}
		AgentRegistry.resetGlobalForTests();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("holds extension agent_end and ctx.isIdle while a child is running", async () => {
		registerChild("Scout", "Main");

		expect(session.isIdle).toBe(false);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates).toEqual([false]);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(false);
		expect(emitSessionStop).toHaveBeenCalledTimes(1);

		AgentRegistry.global().setStatus("Scout", "idle");
		await flushExtensionLifecycle();

		expect(session.isIdle).toBe(true);
		expect(agentEndTerminalStates).toEqual([false, true]);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(true);
	});

	it("does not hold settle for a parked child", async () => {
		registerChild("Scout", "Main", "parked");

		expect(session.isIdle).toBe(true);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates.at(-1)).toBe(true);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(true);
	});

	it("tracks nested subagent parents, not only main", async () => {
		await session.dispose();
		session = createSession({ agentId: "Scout", agentKind: "sub" });
		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") agentEndTerminalStates.push(event.isTerminal);
		});
		registerChild("Nested", "Scout");

		expect(session.isIdle).toBe(false);
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(agentEndTerminalStates).toEqual([false]);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(false);
	});

	it("does not double-emit terminal agent_end after a manager-backed settle supersedes the hold", async () => {
		await session.dispose();
		session = createSession({ asyncJobs: true });
		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") agentEndTerminalStates.push(event.isTerminal);
		});
		registerChild("Scout", "Main");
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager!.register("bash", "gated job owned by Main", async () => await gate.promise, { ownerId: "Main" });

		emitTextOnlyStop();
		await session.waitForIdle();
		expect(agentEndTerminalStates).toEqual([false]);
		expect(emitSessionStop).not.toHaveBeenCalled();

		AgentRegistry.global().setStatus("Scout", "idle");
		await flushExtensionLifecycle();
		expect(agentEndTerminalStates).toEqual([false]);

		gate.resolve("done");
		await session.waitForIdle();
		emitTextOnlyStop();
		await session.waitForIdle();

		const terminalEnds = agentEndTerminalStates.filter(state => state === true);
		expect(terminalEnds).toHaveLength(1);
		AgentRegistry.global().setStatus("Scout", "parked");
		await flushExtensionLifecycle();
		expect(agentEndTerminalStates.filter(state => state === true)).toHaveLength(1);
	});

	it("ignores running children registered on a different registry", async () => {
		const isolated = new AgentRegistry();
		const other = createSession({ agentRegistry: isolated });
		registerChild("Scout", "Main");
		expect(session.isIdle).toBe(false);
		expect(other.isIdle).toBe(true);
		isolated.register({
			id: "Scout",
			displayName: "Scout",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		expect(other.isIdle).toBe(false);
		await other.dispose();
	});

	it("keeps a grandchild live after the intermediate parent unregisters", () => {
		registerChild("Mid", "Main");
		registerChild("Nested", "Mid");
		expect(session.isIdle).toBe(false);
		AgentRegistry.global().unregister("Mid");
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(true);
		expect(session.isIdle).toBe(false);
	});

	it("does not steal grandchild ancestry when an intermediate id is reused", () => {
		registerChild("Mid", "Main");
		registerChild("Nested", "Mid");
		AgentRegistry.global().unregister("Mid");
		registerChild("Mid", "Other");
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(true);
		expect(AgentRegistry.global().isDescendantOf("Other", "Nested")).toBe(false);
		expect(session.isIdle).toBe(false);
	});

	it("does not attribute old descendants to a reused root id", () => {
		const isolated = new AgentRegistry();
		isolated.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			status: "running",
		});
		isolated.register({
			id: "Nested",
			displayName: "Nested",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		isolated.unregister("Main");
		isolated.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			status: "running",
		});
		expect(isolated.isDescendantOf("Main", "Nested")).toBe(false);
		expect(isolated.hasRunningDescendant("Main")).toBe(false);
	});

	it("walks ancestry when a reused id appears at two generations", () => {
		const isolated = new AgentRegistry();
		const row = (id: string, parentId?: string) =>
			isolated.register({
				id,
				displayName: id,
				kind: id === "Main" ? "main" : "sub",
				parentId,
				session: null,
				status: "running",
			});
		row("Main");
		row("A", "Main");
		row("B", "A");
		isolated.unregister("A");
		row("A", "B");
		row("C", "A");
		expect(isolated.isDescendantOf("Main", "C")).toBe(true);
		expect(isolated.hasRunningDescendant("Main")).toBe(true);
	});
	it("holds idle while a parked child is still finalizing", () => {
		registerChild("Scout", "Main", "parked");
		expect(session.isIdle).toBe(true);

		AgentRegistry.global().markFinalizing("Scout");
		expect(session.isIdle).toBe(false);
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(true);

		AgentRegistry.global().clearFinalizing("Scout");
		expect(session.isIdle).toBe(true);
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(false);
	});

	it("keeps a one-shot child live after unregister until finalization clears", () => {
		registerChild("Scout", "Main");
		AgentRegistry.global().markFinalizing("Scout");
		AgentRegistry.global().unregister("Scout");
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(true);
		expect(session.isIdle).toBe(false);

		AgentRegistry.global().clearFinalizing("Scout");
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(false);
		expect(session.isIdle).toBe(true);
	});

	it("overlapping finalizing holds keep the parent working until the last clear", () => {
		registerChild("Scout", "Main", "idle");
		AgentRegistry.global().markFinalizing("Scout");
		AgentRegistry.global().markFinalizing("Scout");
		AgentRegistry.global().clearFinalizing("Scout");
		expect(session.isIdle).toBe(false);
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(true);
		AgentRegistry.global().clearFinalizing("Scout");
		expect(session.isIdle).toBe(true);
		expect(AgentRegistry.global().hasRunningDescendant("Main")).toBe(false);
	});

	it("clearing an unregistered finalizer delivers the held parent agent_end", async () => {
		registerChild("Scout", "Main");
		AgentRegistry.global().markFinalizing("Scout");
		emitTextOnlyStop();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(agentEndTerminalStates).toEqual([false]);

		AgentRegistry.global().unregister("Scout");
		AgentRegistry.global().clearFinalizing("Scout");
		await flushExtensionLifecycle();

		expect(session.isIdle).toBe(true);
		expect(agentEndTerminalStates).toEqual([false, true]);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(true);
	});

	it("drops a queued synthetic settle when another descendant cycle starts first", async () => {
		const gate = Promise.withResolvers<void>();
		let block = true;
		extensionEmit.mockImplementation(async () => {
			if (block) await gate.promise;
		});

		registerChild("First", "Main");
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(agentEndTerminalStates).toEqual([false]);

		AgentRegistry.global().setStatus("First", "idle");
		await Promise.resolve();
		registerChild("Second", "Main");
		AgentRegistry.global().setStatus("First", "parked");
		await Promise.resolve();
		AgentRegistry.global().setStatus("Second", "idle");

		block = false;
		gate.resolve();
		for (let i = 0; i < 40; i++) await Promise.resolve();
		await flushExtensionLifecycle();

		expect(agentEndTerminalStates.filter(state => state === true)).toHaveLength(1);
		expect(session.isIdle).toBe(true);
	});
});

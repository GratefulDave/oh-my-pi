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

	function createSession(opts?: { agentId?: string; agentKind?: "main" | "sub"; asyncJobs?: boolean }): AgentSession {
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
		await Promise.resolve();
		await Promise.resolve();

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
		await Promise.resolve();
		await Promise.resolve();
		expect(agentEndTerminalStates).toEqual([false]);

		gate.resolve("done");
		await session.waitForIdle();
		emitTextOnlyStop();
		await session.waitForIdle();

		const terminalEnds = agentEndTerminalStates.filter(state => state === true);
		expect(terminalEnds).toHaveLength(1);
		AgentRegistry.global().setStatus("Scout", "parked");
		await Promise.resolve();
		await Promise.resolve();
		expect(agentEndTerminalStates.filter(state => state === true)).toHaveLength(1);
	});
});

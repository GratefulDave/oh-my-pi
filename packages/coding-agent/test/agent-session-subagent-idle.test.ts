import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
	let agentEndTerminalStates: Array<boolean | undefined>;

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

	function emitTextOnlyStop(): void {
		const msg = textOnlyAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-parent-subagent-idle-");
		extensionEmit = vi.fn().mockResolvedValue(undefined);
		const extensionRunner = {
			emit: extensionEmit,
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn(() => false),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
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
			agentId: "Main",
			extensionRunner,
		});

		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") {
				agentEndTerminalStates.push(event.isTerminal);
			}
		});
	});

	afterEach(async () => {
		await session.dispose();
		AgentRegistry.resetGlobalForTests();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("holds extension agent_end and ctx.isIdle while a child is running", async () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "Scout",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});

		expect(session.isIdle).toBe(false);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates).toEqual([false]);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(false);

		AgentRegistry.global().setStatus("Scout", "idle");
		await Promise.resolve();
		await Promise.resolve();

		expect(session.isIdle).toBe(true);
		expect(agentEndTerminalStates).toEqual([false, true]);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(true);
	});

	it("does not hold settle for a parked child", async () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "Scout",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});

		expect(session.isIdle).toBe(true);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates.at(-1)).toBe(true);
		expect(extensionEmit.mock.calls.some(call => call[0]?.type === "agent_end")).toBe(true);
	});
});

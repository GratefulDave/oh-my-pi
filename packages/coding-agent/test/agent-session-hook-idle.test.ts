import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Herdr (and any lifecycle-hook host) takes `ctx.isIdle()` plus parent
 * `agent_end.willContinue` as the only working/idle signal once a reporter
 * has claimed the pane. A text-only parent settle while `hub wait` is
 * watching live children used to look idle: `#hasPendingAsyncWake()`
 * ignores watched jobs, so the session emitted a terminal `agent_end`.
 *
 * Contract:
 * 1. Owned running jobs keep `isHookIdle()` false even when `hub wait`
 *    has suppressed their delivery (`hasPendingAsyncWork() === false`).
 * 2. That settle tags extension `agent_end.willContinue` and skips
 *    `session_stop`.
 * 3. After the job drains, the next text-only stop is terminal.
 * 4. A job owned by a different agent does not hold this session idle.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession hook idle while children run", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let manager: AsyncJobManager;
	let extensionRunner: ExtensionRunner;
	let emit: Mock<(event: { type?: string; willContinue?: boolean }) => Promise<void>>;
	let gates: Array<PromiseWithResolvers<string>>;
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

	function registerGatedJob(ownerId: string): { id: string; resolve: () => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		const id = manager.register("task", `gated job owned by ${ownerId}`, async () => await gate.promise, {
			ownerId,
		});
		return { id, resolve: () => gate.resolve("done") };
	}

	function agentEndWillContinueFlags(): Array<boolean | undefined> {
		return emit.mock.calls
			.map(call => call[0] as { type?: string; willContinue?: boolean })
			.filter(event => event.type === "agent_end")
			.map(event => event.willContinue);
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-hook-idle-");
		sessionManager = SessionManager.inMemory(tempDir.path());
		manager = new AsyncJobManager({});
		gates = [];
		emit = vi.fn().mockResolvedValue(undefined);
		extensionRunner = {
			emit,
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry: sharedModelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			extensionRunner,
		});
		manager.registerDeliverySink("Main", () => {});

		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") {
				agentEndTerminalStates.push(
					(event as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal?: boolean }).isTerminal,
				);
			}
		});
	});

	afterEach(async () => {
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		manager.cancelAll();
		await manager.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("stays non-idle for an owned job whose delivery hub wait suppressed", async () => {
		const job = registerGatedJob("Main");
		manager.watchJobs([job.id]);

		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(session.isHookIdle()).toBe(false);

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates).toEqual([false]);
		expect(agentEndWillContinueFlags()).toEqual([true]);
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();
		expect(session.isHookIdle()).toBe(false);
	});

	it("emits a terminal agent_end once the suppressed owned job drains", async () => {
		const job = registerGatedJob("Main");
		manager.watchJobs([job.id]);

		emitTextOnlyStop();
		await session.waitForIdle();

		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();
		expect(session.isHookIdle()).toBe(true);

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates).toEqual([false, true]);
		expect(agentEndWillContinueFlags()).toEqual([true, undefined]);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("does not hold idle for a running job owned by a different agent", async () => {
		registerGatedJob("OtherAgent");

		expect(session.isHookIdle()).toBe(true);

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(agentEndTerminalStates).toEqual([true]);
		expect(agentEndWillContinueFlags()).toEqual([undefined]);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeBridge() {
	const woken: AgentMessage[][] = [];
	const host = {
		isDisposed: () => false,
		isStreaming: () => false,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
	} as unknown as IrcBridgeHost;
	return { bridge: new IrcBridge(host), woken };
}

describe("IrcBridge wake-relay marking", () => {
	it("marks relay messages so the peer never relays them back", async () => {
		const { bridge, woken } = makeBridge();
		const outcome = await bridge.deliver(
			{ id: "irc-1", from: "B", to: "A", body: "You hang up", ts: Date.now(), wakeRelay: true },
			undefined,
		);

		expect(outcome).toBe("woken");
		expect(woken).toHaveLength(1);
		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ from: "B", wakeRelay: true });
		// The model-facing card must not promise a relay that will never come.
		expect(record.content).toContain("No one replies on your behalf");
	});

	it("still advertises the stop relay for genuine messages", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({ id: "irc-2", from: "B", to: "A", body: "status?", ts: Date.now() }, undefined);

		const record = woken[0][0] as CustomMessage;
		expect(record.details).not.toHaveProperty("wakeRelay");
		expect(record.content).toContain("is delivered to");
	});
});

describe("IrcBridge auto-reply bus", () => {
	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("sends plan-mode auto-replies on the session registry bus", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "me",
			displayName: "me",
			kind: "main",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "peer",
			displayName: "peer",
			kind: "sub",
			session: null,
			status: "running",
		});
		const bus = IrcBus.forRegistry(registry);
		const replyPromise = bus.wait("peer", { from: "me" }, 2000);
		const host: IrcBridgeHost = {
			agent: {
				appendMessage: () => {},
				steer: () => {},
				emitExternalEvent: () => {},
			} as unknown as IrcBridgeHost["agent"],
			sessionManager: {
				appendCustomMessageEntry: () => {},
			} as unknown as IrcBridgeHost["sessionManager"],
			settings: Settings.isolated(),
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => true,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
			runEphemeralTurn: async () => ({ replyText: "still planning" }),
			agentRegistry: () => registry,
		};
		const bridge = new IrcBridge(host);

		const outcome = await bridge.deliver(
			{ id: "m1", from: "peer", to: "me", body: "status?", ts: Date.now() },
			{ expectsReply: true },
		);
		expect(outcome).toBe("injected");

		const reply = await replyPromise;
		expect(reply?.replyTo).toBe("m1");
		expect(reply?.body).toBe("still planning");
		expect(IrcBus.global().unreadCount("peer")).toBe(0);
	});

	it("steers a streaming child when the parent is in the session registry", async () => {
		const steered: string[] = [];
		const registry = new AgentRegistry();
		registry.register({
			id: "child",
			displayName: "child",
			kind: "sub",
			parentId: "parent",
			session: null,
			status: "running",
		});
		const host: IrcBridgeHost = {
			agent: {
				appendMessage: () => {},
				steer: (message: { content: string }) => {
					steered.push(message.content);
				},
				emitExternalEvent: () => {},
			} as unknown as IrcBridgeHost["agent"],
			sessionManager: {
				appendCustomMessageEntry: () => {},
			} as unknown as IrcBridgeHost["sessionManager"],
			settings: Settings.isolated(),
			isDisposed: () => false,
			isStreaming: () => true,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
			runEphemeralTurn: async () => ({ replyText: "" }),
			agentRegistry: () => registry,
		};
		const bridge = new IrcBridge(host);

		const outcome = await bridge.deliver(
			{ id: "m2", from: "parent", to: "child", body: "stop that path", ts: Date.now() },
			undefined,
		);

		expect(outcome).toBe("injected");
		expect(steered).toHaveLength(1);
		expect(steered[0]).toContain("parent");
		expect(steered[0]).toContain("stop that path");
	});
});

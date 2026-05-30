import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import type { ToolSession } from "../src/tools";
import { IrcTool } from "../src/tools/irc";

describe("Actor IRC Routing", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("routes direct messages and tracks unread count in registry", async () => {
		const senderId = MAIN_AGENT_ID;
		const recipientId = "subagent-1";

		// Spawning/Registering recipient
		const recipientRef = registry.register({
			id: recipientId,
			displayName: "Subagent 1",
			kind: "sub",
			session: null,
			status: "idle",
		});

		const settings = Settings.isolated({ "irc.enabled": true });
		const mockSession = {
			settings,
			agentRegistry: registry,
			getAgentId: () => senderId,
		} as unknown as ToolSession;

		const ircTool = new IrcTool(mockSession);

		// Sending DM asynchronously (awaitReply = false)
		const sendResult = await ircTool.execute("call-id-1", {
			op: "send",
			to: recipientId,
			message: "hello coworker!",
			awaitReply: false,
		});

		expect(sendResult.details!.delivered).toEqual([recipientId]);
		expect(recipientRef.mailbox.count).toBe(1);
		expect(recipientRef.mailbox.unreadCount).toBe(1);
		expect(recipientRef.mailbox.listUnread()[0].content).toBe("hello coworker!");

		// Listing unread status via tool list
		const listResult = await ircTool.execute("call-id-2", {
			op: "list",
		});

		expect((listResult.content![0] as any).text).toContain("(1 unread)");
	});

	test("supports offline buffering for unregistered actors", async () => {
		const senderId = MAIN_AGENT_ID;
		const offlineRecipientId = "offline-subagent";

		const settings = Settings.isolated({ "irc.enabled": true });
		const mockSession = {
			settings,
			agentRegistry: registry,
			getAgentId: () => senderId,
		} as unknown as ToolSession;

		const ircTool = new IrcTool(mockSession);
		// Pre-register offline recipient to simulate the orchestrator planning/pre-registering it
		registry.register({
			id: offlineRecipientId,
			displayName: "Offline Subagent",
			kind: "sub",
			session: null,
			status: "running",
		});

		// Routing to unregistered/offline agent
		const sendResult = await ircTool.execute("call-id-3", {
			op: "send",
			to: offlineRecipientId,
			message: "buffering this message!",
			awaitReply: false,
		});

		expect(sendResult.details!.delivered).toEqual([offlineRecipientId]);

		// Mailbox is created in registry and buffers message offline
		const bufferedMailbox = registry.getOrCreateMailbox(offlineRecipientId);
		expect(bufferedMailbox.count).toBe(1);
		expect(bufferedMailbox.listUnread()[0].content).toBe("buffering this message!");

		// Recipient boots up and registers
		const recipientRef = registry.register({
			id: offlineRecipientId,
			displayName: "Newly Booted Agent",
			kind: "sub",
			session: null,
			status: "running",
		});

		// Mailbox is linked immediately upon boot and unread messages are preserved
		expect(recipientRef.mailbox.count).toBe(1);
		expect(recipientRef.mailbox.listUnread()[0].id).toBe(bufferedMailbox.list()[0].id);
	});

	test("broadcasts to all active agents except sender", async () => {
		const senderId = MAIN_AGENT_ID;

		const ref1 = registry.register({
			id: "agent-1",
			displayName: "Agent 1",
			kind: "sub",
			session: null,
			status: "idle",
		});
		const ref2 = registry.register({
			id: "agent-2",
			displayName: "Agent 2",
			kind: "sub",
			session: null,
			status: "running",
		});

		const settings = Settings.isolated({ "irc.enabled": true });
		const mockSession = {
			settings,
			agentRegistry: registry,
			getAgentId: () => senderId,
		} as unknown as ToolSession;

		const ircTool = new IrcTool(mockSession);

		const sendResult = await ircTool.execute("call-id-4", {
			op: "send",
			to: "all",
			message: "broadcast alert!",
			awaitReply: false,
		});

		expect(sendResult.details!.delivered).toContain("agent-1");
		expect(sendResult.details!.delivered).toContain("agent-2");

		expect(ref1.mailbox.count).toBe(1);
		expect(ref1.mailbox.listUnread()[0].content).toBe("broadcast alert!");

		expect(ref2.mailbox.count).toBe(1);
		expect(ref2.mailbox.listUnread()[0].content).toBe("broadcast alert!");
	});
});

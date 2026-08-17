import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SessionShutdownEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession shutdown disposition", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shutdown-disposition-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(): { session: AgentSession; shutdownEvents: SessionShutdownEvent[] } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const shutdownEvents: SessionShutdownEvent[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_shutdown",
			emit: async (event: SessionShutdownEvent) => {
				shutdownEvents.push(event);
			},
		} as unknown as ExtensionRunner;
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessions.push(session);
		return { session, shutdownEvents };
	}

	it("marks terminal quit as release-eligible but keeps programmatic disposal ineligible", async () => {
		const terminal = createSession();
		const replacement = createSession();

		await terminal.session.dispose({ shutdownReason: "quit" });
		await replacement.session.dispose();

		expect(terminal.shutdownEvents).toEqual([{ type: "session_shutdown", reason: "quit" }]);
		expect(replacement.shutdownEvents).toEqual([{ type: "session_shutdown", reason: "dispose" }]);
	});
});

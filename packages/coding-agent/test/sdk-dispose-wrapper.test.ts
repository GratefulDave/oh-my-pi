import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("createAgentSession dispose wrapper", () => {
	let tempDir: string | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let releaseLifecycleDispose: (() => void) | undefined;

	afterEach(async () => {
		releaseLifecycleDispose?.();
		await session?.dispose().catch(() => {});
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
		releaseLifecycleDispose = undefined;
		vi.restoreAllMocks();
	});

	it("latches the first dispose options before global lifecycle teardown awaits", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-dispose-wrapper-"));
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const lifecycleGate = Promise.withResolvers<void>();
		releaseLifecycleDispose = lifecycleGate.resolve;
		const lifecycleDispose = vi.fn(() => lifecycleGate.promise);
		vi.spyOn(AgentLifecycleManager, "global").mockReturnValue({
			dispose: lifecycleDispose,
			isParking: () => false,
		} as unknown as AgentLifecycleManager);
		const originalDispose = vi.spyOn(AgentSession.prototype, "dispose");

		({ session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: new ModelRegistry(authStorage),
		}));

		const terminalDispose = session.dispose({ shutdownReason: "quit" });
		const competingDispose = session.dispose();
		expect(lifecycleDispose).toHaveBeenCalledTimes(1);

		lifecycleGate.resolve();
		await Promise.all([terminalDispose, competingDispose]);
		expect(originalDispose).toHaveBeenCalledTimes(1);
		expect(originalDispose).toHaveBeenCalledWith({ shutdownReason: "quit" });
	});
});

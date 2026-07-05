import type { Mock } from "bun:test";
import { describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import profileManagerExtension, { applyProfile } from "../../../../.omp/extensions/profile-manager/index";

// ── Stubs ────────────────────────────────────────────────────────────────────

function makeModel(provider: string, id: string): Model {
	return { provider, id } as unknown as Model;
}

interface ApiCallLog {
	replaceModelRoles: Mock<() => void>;
	overrideEnabledModels: Mock<() => void>;
	overrideModelRoles: Mock<() => void>;
	setModel: Mock<() => void>;
	setThinkingLevel: Mock<() => void>;
}

function makeStubApi(log: ApiCallLog) {
	return {
		setModel: log.setModel,
		setThinkingLevel: log.setThinkingLevel,
		sendMessage: mock(),
		getFlag: mock(() => undefined),
		// The three methods that are the test subject:
		replaceModelRoles: log.replaceModelRoles,
		overrideEnabledModels: log.overrideEnabledModels,
		overrideModelRoles: log.overrideModelRoles,
	};
}

function makeStubCtx(models: Model[] = []) {
	const allModels = models;
	return {
		models: { list: () => models },
		modelRegistry: {
			getAll: () => allModels,
			find: (_p: string, _id: string) => undefined,
			resolveCanonicalModel: (_id: string) => undefined,
			getCanonicalVariants: () => [],
		},
		hasUI: false,
	};
}

function freshLog(): ApiCallLog {
	return {
		replaceModelRoles: mock(),
		overrideEnabledModels: mock(),
		overrideModelRoles: mock(),
		setModel: mock(() => true),
		setThinkingLevel: mock(),
	};
}

interface CapturedCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
}

async function withIsolatedAgentDir<T>(run: (agentDir: string) => T | Promise<T>): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOmpProfile = process.env.OMP_PROFILE;
	const previousPiProfile = process.env.PI_PROFILE;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-extension-test-"));

	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	try {
		return await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousOmpProfile === undefined) {
			delete process.env.OMP_PROFILE;
		} else {
			process.env.OMP_PROFILE = previousOmpProfile;
		}
		if (previousPiProfile === undefined) {
			delete process.env.PI_PROFILE;
		} else {
			process.env.PI_PROFILE = previousPiProfile;
		}
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

function loadProfileManagerCommand(): {
	command: CapturedCommand;
	cleanup: () => void;
	messages: string[];
} {
	const commands = new Map<string, CapturedCommand>();
	const messages: string[] = [];
	const exitListenersBefore = new Set(process.listeners("exit"));

	profileManagerExtension({
		setLabel: mock(),
		registerFlag: mock(),
		on: mock(),
		registerCommand: mock((name: string, command: CapturedCommand) => {
			commands.set(name, command);
		}),
		sendMessage: mock((message: { content?: string }) => {
			if (message.content !== undefined) messages.push(message.content);
		}),
		getFlag: mock(() => undefined),
	} as never);

	const command = commands.get("pm");
	expect(command).toBeDefined();

	return {
		command: command!,
		cleanup: () => {
			for (const listener of process.listeners("exit")) {
				if (!exitListenersBefore.has(listener)) {
					process.removeListener("exit", listener);
				}
			}
		},
		messages,
	};
}

describe("profile-manager extension registration", () => {
	it("registers /pm and the list command reports the active profile list", async () => {
		const { command, cleanup, messages } = loadProfileManagerCommand();

		try {
			await withIsolatedAgentDir(async agentDir => {
				fs.writeFileSync(
					path.join(agentDir, "config.yml"),
					[
						"activeModelProfile: plan",
						"modelProfiles:",
						"  plan:",
						"    defaultThinkingLevel: high",
						"  smol:",
						"    defaultThinkingLevel: low",
						"",
					].join("\n"),
					"utf8",
				);

				await command.handler("list", { hasUI: false });
			});
		} finally {
			cleanup();
		}

		expect(messages).toEqual([
			["Active model profile: plan", "Model profiles:", "  default", "  plan (active)", "  smol", ""].join("\n"),
		]);
	});
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("profile-manager applyProfile", () => {
	describe("role override method", () => {
		it("calls replaceModelRoles (not additive overrideModelRoles)", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			const profile = {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: ["ag/*"],
			};

			await applyProfile(api as never, ctx as never, profile);

			expect(log.replaceModelRoles).toHaveBeenCalledTimes(1);
			expect(log.replaceModelRoles).toHaveBeenCalledWith(profile.modelRoles);
			expect(log.overrideModelRoles).not.toHaveBeenCalled();
		});

		it("replaces with empty object when profile has no modelRoles", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([]);

			await applyProfile(api as never, ctx as never, {});

			expect(log.replaceModelRoles).toHaveBeenCalledTimes(1);
			expect(log.replaceModelRoles).toHaveBeenCalledWith({});
		});
	});

	describe("enabledModels override", () => {
		it("calls overrideEnabledModels with profile patterns", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: ["ag/*"],
			});

			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(["ag/*"]);
		});

		it("calls overrideEnabledModels(null) when profile has no enabledModels", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
			});

			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(null);
		});

		it("calls overrideEnabledModels(null) when enabledModels is empty array", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([makeModel("ag", "claude-sonnet-4-6")]);

			await applyProfile(api as never, ctx as never, {
				modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
				enabledModels: [],
			});

			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(null);
		});
	});

	describe("switchModel=false skips model switch but still applies overrides", () => {
		it("applies role + enabledModels overrides even without model switch", async () => {
			const log = freshLog();
			const api = makeStubApi(log);
			const ctx = makeStubCtx([]);

			await applyProfile(
				api as never,
				ctx as never,
				{
					modelRoles: { default: "ag/claude-sonnet-4-6:auto" },
					enabledModels: ["ag/*"],
				},
				{ switchModel: false },
			);

			expect(log.replaceModelRoles).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledTimes(1);
			expect(log.overrideEnabledModels).toHaveBeenCalledWith(["ag/*"]);
			expect(log.setModel).not.toHaveBeenCalled();
		});
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import profileManagerExtension from "./index";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: CommandContext) => Promise<void>;
}

interface CommandContext {
	hasUI: boolean;
	model?: Model;
	modelRegistry: {
		getAll(): Model[];
		find(provider: string, modelId: string): Model | undefined;
		resolveCanonicalModel(id: string): Model | undefined;
	};
	models: {
		list(): Model[];
	};
}

type EventHandler = (event: unknown, ctx: CommandContext) => void | Promise<void>;

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPiProfile = process.env.PI_PROFILE;

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	if (originalPiProfile === undefined) {
		delete process.env.PI_PROFILE;
	} else {
		process.env.PI_PROFILE = originalPiProfile;
	}
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function createHarness() {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-manager-"));
	tempDirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const commands = new Map<string, RegisteredCommand>();
	const events = new Map<string, EventHandler>();
	const notifications: string[] = [];
	const appliedSettings: Array<Record<string, unknown>> = [];
	const model: Model = {
		provider: "nvidia",
		id: "moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-chat",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as Model;

	const api = {
		setLabel(_value: string) {},
		on(event: string, handler: EventHandler) {
			events.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		sendMessage(message: { content?: string }) {
			if (typeof message.content === "string") notifications.push(message.content);
		},
		applySettings(patch: Record<string, unknown>) {
			appliedSettings.push(patch);
		},
		async setModel(candidate: Model) {
			return candidate.provider === model.provider && candidate.id === model.id;
		},
		getThinkingLevel() {
			return undefined;
		},
	};

	profileManagerExtension(api as never);

	const ctx: CommandContext = {
		hasUI: false,
		modelRegistry: {
			getAll: () => [model],
			find: (provider, modelId) => (provider === model.provider && modelId === model.id ? model : undefined),
			resolveCanonicalModel: id => (id === model.id ? model : undefined),
		},
		models: {
			list: () => [model],
		},
	};

	return { agentDir, commands, events, notifications, appliedSettings, ctx, model };
}

describe("profile manager extension", () => {
	test("clears stale enabledModels when switching to a profile without its own scope", async () => {
		const harness = await createHarness();
		await Bun.write(
			path.join(harness.agentDir, "config.yml"),
			YAML.stringify({
				enabledModels: ["openai-codex/gpt-5.4-mini"],
				modelProfiles: {
					nvidia: {
						modelRoles: {
							default: `${harness.model.provider}/${harness.model.id}`,
						},
					},
				},
			}),
		);

		const command = harness.commands.get("pm");
		expect(command).toBeDefined();
		await command?.handler("use nvidia", harness.ctx);

		expect(harness.appliedSettings.at(-1)).toEqual({
			enabledModels: [],
			modelRoles: {
				default: `${harness.model.provider}/${harness.model.id}`,
			},
		});
		const written = (YAML.parse(await Bun.file(path.join(harness.agentDir, "config.yml")).text()) ?? {}) as {
			activeModelProfile?: string;
			enabledModels?: string[];
			modelRoles?: Record<string, string>;
		};
		expect(written.activeModelProfile).toBe("nvidia");
		expect(written.enabledModels).toEqual([]);
		expect(written.modelRoles).toEqual({
			default: `${harness.model.provider}/${harness.model.id}`,
		});
		expect(harness.notifications.at(-1)).toContain("Switched to nvidia/moonshotai/kimi-k2.6");
	});

	test("clears stale assigned roles when switching to a profile without modelRoles", async () => {
		const harness = await createHarness();
		await Bun.write(
			path.join(harness.agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: {
					default: "omlx/Qwen3-Coder-Next-MLX-4bit",
					task: "omlx/Qwen3-Coder-Next-MLX-4bit",
					smol: "omlx/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-mlx-8bit",
				},
				modelProfiles: {
					clean: {},
				},
			}),
		);

		const command = harness.commands.get("pm");
		expect(command).toBeDefined();
		await command?.handler("use clean", harness.ctx);

		expect(harness.appliedSettings.at(-1)).toEqual({
			modelRoles: {},
			enabledModels: [],
		});
		const written = (YAML.parse(await Bun.file(path.join(harness.agentDir, "config.yml")).text()) ?? {}) as {
			activeModelProfile?: string;
			modelRoles?: Record<string, string>;
			enabledModels?: string[];
		};
		expect(written.activeModelProfile).toBe("clean");
		expect(written.modelRoles).toEqual({});
		expect(written.enabledModels).toEqual([]);
		expect(harness.notifications.at(-1)).toContain("No 'default' role");
	});

	test("startup prefers the current OMP profile name and skips stale saved profiles", async () => {
		const harness = await createHarness();
		process.env.PI_PROFILE = "openai-performance";
		await Bun.write(
			path.join(harness.agentDir, "config.yml"),
			YAML.stringify({
				activeModelProfile: "omlx",
				modelProfiles: {
					omlx: {
						modelRoles: {
							default: "omlx/Qwen3-Coder-Next-MLX-4bit",
						},
					},
					"openai-performance": {
						modelRoles: {
							default: `${harness.model.provider}/${harness.model.id}`,
						},
					},
				},
			}),
		);

		const onStart = harness.events.get("session_start");
		expect(onStart).toBeDefined();
		await onStart?.({}, harness.ctx);

		expect(harness.appliedSettings.at(-1)).toEqual({
			modelRoles: {
				default: `${harness.model.provider}/${harness.model.id}`,
			},
			enabledModels: [],
		});
		expect(harness.notifications.at(-1)).toContain('startup: profile "openai-performance"');
	});

	test("built bundle still registers the pm command", async () => {
		const harness = await createHarness();
		const bundleModule = await import(`./dist/index.js?ts=${Date.now()}`);
		expect(typeof bundleModule.default).toBe("function");

		const commands = new Map<string, RegisteredCommand>();
		const events = new Map<string, EventHandler>();
		bundleModule.default({
			setLabel(_value: string) {},
			on(event: string, handler: EventHandler) {
				events.set(event, handler);
			},
			registerCommand(name: string, command: RegisteredCommand) {
				commands.set(name, command);
			},
			sendMessage(_message: { content?: string }) {},
			applySettings(_patch: Record<string, unknown>) {},
			async setModel(_candidate: Model) {
				return true;
			},
			getThinkingLevel() {
				return undefined;
			},
		} as never);

		expect(commands.has("pm")).toBe(true);
		expect(events.has("session_start")).toBe(true);
		expect(events.has("session_switch")).toBe(true);
		expect(harness.commands.has("pm")).toBe(true);
	});
});

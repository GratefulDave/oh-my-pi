import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { runProfileCommand } from "../src/cli/profile-cli";
import { resetSettingsForTest } from "../src/config/settings";

let testAgentDir = "";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function readConfig(): Promise<Record<string, unknown>> {
	const file = Bun.file(path.join(testAgentDir, "config.yml"));
	if (!(await file.exists())) return {};
	const parsed = YAML.parse(await file.text());
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

beforeEach(async () => {
	resetSettingsForTest();
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-cli-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

describe("profile CLI", () => {
	it("creates, lists, shows, activates, and deletes profiles in JSON mode", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runProfileCommand({ action: "create", name: "fast", flags: { empty: true, activate: true, json: true } });
		await runProfileCommand({ action: "list", flags: { json: true } });
		await runProfileCommand({ action: "show", name: "fast", flags: { json: true } });
		await runProfileCommand({ action: "use", name: "default", flags: { json: true } });
		await runProfileCommand({ action: "delete", name: "fast", flags: { json: true } });

		const listPayload = JSON.parse(String(logSpy.mock.calls[1]?.[0])) as { active: string; profiles: string[] };
		expect(listPayload).toEqual({ active: "fast", profiles: ["fast"] });
		const showPayload = JSON.parse(String(logSpy.mock.calls[2]?.[0])) as { name: string; settings: unknown };
		expect(showPayload.name).toBe("fast");
		expect(showPayload.settings).toEqual({});
		const usePayload = JSON.parse(String(logSpy.mock.calls[3]?.[0])) as { active: string };
		expect(usePayload.active).toBe("default");
		const deletePayload = JSON.parse(String(logSpy.mock.calls[4]?.[0])) as { deleted: string; active: string };
		expect(deletePayload).toEqual({ deleted: "fast", active: "default" });
	});

	it("sets profile roles, thinking level, and array values", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runProfileCommand({ action: "create", name: "fast", flags: { empty: true, json: true } });
		await runProfileCommand({
			action: "set",
			name: "fast",
			key: "modelRoles.default",
			value: "anthropic/claude-haiku-4-5:low",
			flags: { json: true },
		});
		await runProfileCommand({
			action: "set",
			name: "fast",
			key: "defaultThinkingLevel",
			value: "low",
			flags: { json: true },
		});
		await runProfileCommand({
			action: "set",
			name: "fast",
			key: "enabledModels",
			value: "anthropic/claude-haiku-4-5,openai/gpt-5.2-codex",
			flags: { json: true },
		});

		const config = await readConfig();
		expect(config.modelProfiles).toEqual({
			fast: {
				modelRoles: { default: "anthropic/claude-haiku-4-5:low" },
				defaultThinkingLevel: "low",
				enabledModels: ["anthropic/claude-haiku-4-5", "openai/gpt-5.2-codex"],
			},
		});
	});

	it("applies openrouter preset when creating a profile", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runProfileCommand({
			action: "create",
			name: "openrouter",
			flags: { empty: true, json: true, preset: "openrouter" },
		});

		const config = await readConfig();
		expect(config.modelProfiles).toEqual({
			openrouter: {
				enabledModels: ["openrouter/*"],
				modelProviderOrder: ["openrouter"],
			},
		});
	});

	it("rejects default as a creatable or deletable profile", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);

		await expect(runProfileCommand({ action: "create", name: "default", flags: { json: true } })).rejects.toThrow(
			"exit",
		);
		await expect(runProfileCommand({ action: "delete", name: "default", flags: { json: true } })).rejects.toThrow(
			"exit",
		);
		expect(exitSpy).toHaveBeenCalledTimes(2);
	});
});

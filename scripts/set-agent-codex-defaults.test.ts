import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { normalizeAgentConfigFiles, normalizeAgentDefaults } from "./set-agent-codex-defaults";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("agent Codex defaults", () => {
	it("maps existing OpenRouter agent overrides and installs fixed built-in defaults", () => {
		const settings: Record<string, unknown> = {
			task: {
				agentModelOverrides: {
					architect: "openrouter/anthropic/claude-opus-4.8:high",
					implementer: "openrouter/anthropic/claude-sonnet-4.6",
					writer: "openrouter/anthropic/claude-haiku-4.5",
					unknown: "openrouter/z-ai/glm-5.2",
					local: "ollama/qwen3",
				},
			},
		};

		expect(normalizeAgentDefaults(settings)).toBeTrue();
		expect(settings.task).toEqual({
			defaultModel: "openai-codex/gpt-5.6-terra:auto",
			agentModelOverrides: {
				architect: "openai-codex/gpt-5.6-sol:auto",
				implementer: "openai-codex/gpt-5.6-terra:auto",
				writer: "openai-codex/gpt-5.6-luna:auto",
				unknown: "openai-codex/gpt-5.6-terra:auto",
				local: "ollama/qwen3",
				designer: "openai-codex/gpt-5.6-sol:auto",
				explore: "openai-codex/gpt-5.6-luna:auto",
				librarian: "openai-codex/gpt-5.6-luna:auto",
				plan: "openai-codex/gpt-5.6-terra:auto",
				reviewer: "openai-codex/gpt-5.6-terra:auto",
				scout: "openai-codex/gpt-5.6-luna:auto",
				sonic: "openai-codex/gpt-5.6-luna:auto",
				task: "openai-codex/gpt-5.6-terra:auto",
				tester: "openai-codex/gpt-5.6-terra:auto",
			},
		});
	});

	it("updates canonical and isolated profile configs while deduplicating symlinks", async () => {
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-codex-defaults-"));
		tempDirs.push(homeDir);
		const canonical = path.join(homeDir, ".omp", "agent", "config.yml");
		const profile = path.join(homeDir, ".omp", "profiles", "openai-standard", "agent", "config.yml");
		await Bun.write(canonical, YAML.stringify({ task: { agentModelOverrides: {} } }, null, 2));
		await Bun.write(profile, YAML.stringify({ task: { agentModelOverrides: {} } }, null, 2));
		await fs.mkdir(path.join(homeDir, ".lex", "agent"), { recursive: true });
		await fs.symlink(canonical, path.join(homeDir, ".lex", "agent", "config.yml"));

		const changed = await normalizeAgentConfigFiles(homeDir);

		expect(changed).toEqual([await fs.realpath(canonical), await fs.realpath(profile)]);
		for (const configPath of changed) {
			const parsed = YAML.parse(await Bun.file(configPath).text()) as {
				task: { defaultModel: string; agentModelOverrides: Record<string, string> };
			};
			expect(parsed.task.defaultModel).toBe("openai-codex/gpt-5.6-terra:auto");
			expect(parsed.task.agentModelOverrides.designer).toBe("openai-codex/gpt-5.6-sol:auto");
			expect(parsed.task.agentModelOverrides.scout).toBe("openai-codex/gpt-5.6-luna:auto");
		}
	});
});

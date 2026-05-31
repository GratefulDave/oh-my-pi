import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as ai from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();
	const addRule = vi.fn();
	const getCwd = vi.fn(() => "/tmp");
	const getBranch = vi.fn(() => []);

	const model = { provider: "anthropic", id: "claude-3" };
	const apiKey = "mock-api-key";
	const getApiKey = vi.fn(() => apiKey);

	return {
		showStatus,
		showError,
		setText,
		addRule,
		getApiKey,
		getBranch,
		runtime: {
			ctx: {
				session: {
					model,
					modelRegistry: {
						authStorage: { getApiKey },
					},
					ttsrManager: { addRule },
				} as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				sessionManager: { getCwd, getBranch } as unknown as InteractiveModeContext["sessionManager"],
				showStatus,
				showError,
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/omfg slash command", () => {
	it("rejects empty complaints", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/omfg", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith("Usage: /omfg <complaint>");
	});

	it("converts a complaint, saves, and registers it", async () => {
		const harness = createRuntime();

		const generatedRule = {
			name: "no-cat-command",
			description: "Do not use cat",
			condition: ["\\\\bcat\\\\b"],
			scope: ["text"],
			content: "Guidelines...",
		};

		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: JSON.stringify(generatedRule) }],
		} as any);

		const expectedPath = "/tmp/.omp/rules/no-cat-command.md";
		try {
			await fs.unlink(expectedPath);
		} catch {}

		const handled = await executeBuiltinSlashCommand(
			"/omfg use hookFetch instead of vi.spyOn fetch",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(completeSpy).toHaveBeenCalled();
		expect(harness.addRule).toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining('Rule "no-cat-command" active!'));

		const stats = await fs.stat(expectedPath);
		expect(stats.isFile()).toBe(true);
		const content = await fs.readFile(expectedPath, "utf8");
		expect(content).toContain("description: Do not use cat");

		// Cleanup
		await fs.unlink(expectedPath);

		completeSpy.mockRestore();
	});
});

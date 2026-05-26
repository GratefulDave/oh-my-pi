import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "../src/config/settings";
import type { ExternalAgentRequest, ExternalAgentResult } from "../src/external-agents";
import * as externalAgents from "../src/external-agents";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionManager } from "../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

function createRuntime(
	cwd: string,
	artifactSaveResult?: string,
): {
	output: string[];
	runtime: SlashCommandRuntime;
} {
	const output: string[] = [];
	return {
		output,
		runtime: {
			session: {} as AgentSession,
			sessionManager: {
				getCwd: () => cwd,
				saveArtifact: async () => artifactSaveResult,
			} as unknown as SessionManager,
			settings: Settings.isolated(),
			cwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

describe("post-split orchestrate/delegate slash command contract", () => {
	it("does not consume /orchestrate in the ACP builtin dispatcher", async () => {
		const { runtime } = createRuntime("/tmp/fake-cwd");

		const result = await executeAcpBuiltinSlashCommand("/orchestrate implement the feature now", runtime);

		expect(result).toBe(false);
	});

	it("does not treat external orchestration flags as a builtin /orchestrate invocation", async () => {
		const { runtime } = createRuntime("/tmp/fake-cwd");

		const result = await executeAcpBuiltinSlashCommand(
			'/orchestrate --backend acpx --agents gemini "review diff"',
			runtime,
		);

		expect(result).toBe(false);
	});

	it("consumes /delegate as external orchestration without spawning a real external agent", async () => {
		const result: ExternalAgentResult = {
			provider: "gemini",
			backend: "acpx",
			session: undefined,
			cwd: "/tmp/fake-cwd",
			events: [],
			text: "fake output",
			exitCode: 0,
			success: true,
		};
		const runSpy = spyOn(externalAgents, "runExternalAgentsParallel").mockResolvedValue([result]);

		try {
			const { output, runtime } = createRuntime("/tmp/fake-cwd");

			const commandResult = await executeAcpBuiltinSlashCommand(
				'/delegate --backend acpx --agents gemini "review diff"',
				runtime,
			);

			expect(commandResult).toEqual({ consumed: true });
			expect(runSpy).toHaveBeenCalledTimes(1);
			const requests = runSpy.mock.calls[0]![0] as ExternalAgentRequest[];
			expect(requests).toEqual([
				{
					provider: "gemini",
					backend: "acpx",
					prompt: "review diff",
					cwd: "/tmp/fake-cwd",
					session: undefined,
					mode: "exec",
					timeoutMs: undefined,
				},
			]);
			expect(output).toHaveLength(1);
			expect(output[0]).toContain("# External Orchestration");
			expect(output[0]).toContain("## gemini");
		} finally {
			runSpy.mockRestore();
		}
	});

	it("persists orchestration artifact and reports the returned artifact id", async () => {
		const result: ExternalAgentResult = {
			provider: "gemini",
			backend: "acpx",
			session: undefined,
			cwd: "/tmp/fake-cwd",
			events: [],
			text: "fake output",
			exitCode: 0,
			success: true,
		};
		const runSpy = spyOn(externalAgents, "runExternalAgentsParallel").mockResolvedValue([result]);

		try {
			const { output, runtime } = createRuntime("/tmp/fake-cwd", "artifact-test-123");

			const commandResult = await executeAcpBuiltinSlashCommand(
				'/delegate --backend acpx --agents gemini "review diff"',
				runtime,
			);

			expect(commandResult).toEqual({ consumed: true });
			expect(output).toHaveLength(2);
			expect(output[0]).toContain("# External Orchestration");
			expect(output[1]).toContain("Artifact persisted: artifact-test-123");
		} finally {
			runSpy.mockRestore();
		}
	});
});

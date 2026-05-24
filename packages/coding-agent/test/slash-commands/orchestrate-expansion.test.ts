import { describe, expect, it } from "bun:test";
import { expandSlashCommand, type FileSlashCommand } from "../../src/extensibility/slash-commands";
import { loadBundledCommands } from "../../src/task/commands";

function bundledOrchestrateCommand(): FileSlashCommand {
	const command = loadBundledCommands().find(item => item.name === "orchestrate");
	if (!command) throw new Error("Bundled orchestrate command missing");
	return {
		name: command.name,
		description: command.description,
		content: command.instructions,
		source: command.source,
	};
}

describe("file-based /orchestrate expansion", () => {
	it("expands bundled /orchestrate to the subagent orchestration prompt", () => {
		const result = expandSlashCommand("/orchestrate implement feature", [bundledOrchestrateCommand()]);

		expect(result).toContain("Orchestration Contract");
		expect(result).toContain("implement feature");
		expect(result).toContain("Every file mutation goes through a `task` subagent");
		expect(result).not.toContain("Usage: /orchestrate");
		expect(result).not.toContain("External Orchestration");
		expect(result).not.toContain("--backend acpx");
		expect(result).not.toContain("--backend tmux");
		expect(result).not.toContain("--backend cmux");
	});

	it("does not expand /delegate as the bundled subagent command", () => {
		const result = expandSlashCommand("/delegate review diff", [bundledOrchestrateCommand()]);

		expect(result).toBe("/delegate review diff");
	});
});

import { describe, expect, it } from "bun:test";
import { loadBundledCommands } from "../../src/task/commands";

describe("file-based /orchestrate expansion", () => {
	it("does not expose /orchestrate as a bundled file command", () => {
		const commands = loadBundledCommands();

		expect(commands.map(command => command.name)).not.toContain("orchestrate");
	});
});

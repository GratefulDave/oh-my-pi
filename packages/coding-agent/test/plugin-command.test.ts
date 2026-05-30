import { describe, expect, it } from "bun:test";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import Plugin from "../src/commands/plugin";
import { filterPluginDependenciesByRuntimeConfig } from "../src/extensibility/plugins/manager";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("Plugin command scope parsing", () => {
	it("rejects invalid scope values", async () => {
		const command = new Plugin(["install", "--scope", "porject"], TEST_CONFIG);
		await expect(command.parse(Plugin)).rejects.toThrow(/Expected --scope to be one of: user, project/);
	});
});

describe("plugin package manifest repair", () => {
	it("drops package.json dependencies that are absent from runtime plugin state", () => {
		const result = filterPluginDependenciesByRuntimeConfig(
			{
				"context-mode": "^1.0.146",
				"dir-entry-plugin": "1.0.0",
				"pi-cmux": "^0.1.16",
			},
			{
				plugins: {
					"context-mode": { version: "1.0.146", enabledFeatures: null, enabled: true },
					"pi-cmux": { version: "0.1.16", enabledFeatures: null, enabled: true },
				},
				settings: {},
			},
		);

		expect(result).toEqual({
			"context-mode": "^1.0.146",
			"pi-cmux": "^0.1.16",
		});
	});
});

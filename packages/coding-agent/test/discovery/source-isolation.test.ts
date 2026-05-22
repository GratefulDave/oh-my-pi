import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeWithSettings } from "../../src/capability";
import { clearCache as clearFsCache } from "../../src/capability/fs";
import { Settings } from "../../src/config/settings";
import { clearClaudePluginRootsCache } from "../../src/discovery/helpers";
import { discoverAgents } from "../../src/task/discovery";

const agentFile = (name: string, description: string) =>
	["---", `name: ${name}`, `description: ${description}`, "---", `${description}.`].join("\n");

describe("discoverAgents — source isolation", () => {
	let tempHome: string;
	let tempProject: string;
	let originalHome: string | undefined;
	let originalPiConfigDir: string | undefined;

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-source-isolation-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-source-isolation-project-"));
		originalHome = process.env.HOME;
		originalPiConfigDir = process.env.PI_CONFIG_DIR;
		process.env.HOME = tempHome;
		delete process.env.PI_CONFIG_DIR;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);

		writeAgent(path.join(tempHome, ".omp", "agent", "agents"), "native-user-agent");
		writeAgent(path.join(tempProject, ".omp", "agents"), "native-project-agent");

		for (const source of [".claude", ".codex", ".gemini"]) {
			const prefix = source.slice(1);
			writeAgent(path.join(tempHome, source, "agents"), `${prefix}-user-agent`);
			writeAgent(path.join(tempProject, source, "agents"), `${prefix}-project-agent`);
		}

		const pluginInstallPath = path.join(tempHome, "plugin-cache", "marketplace-plugin");
		writeAgent(path.join(pluginInstallPath, "agents"), "marketplace-plugin-agent");
		const claudePluginsDir = path.join(tempHome, ".claude", "plugins");
		fs.mkdirSync(claudePluginsDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudePluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"marketplace-plugin@claude-plugins-official": [
						{
							installPath: pluginInstallPath,
							version: "1.0.0",
							scope: "user",
							installedAt: "2026-01-01T00:00:00Z",
							lastUpdated: "2026-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		initializeWithSettings(Settings.isolated({ "compatibility.loadForeignConfig": true }));
		clearFsCache();
		clearClaudePluginRootsCache();
	});

	afterEach(() => {
		initializeWithSettings(Settings.isolated({ "compatibility.loadForeignConfig": true }));
		clearFsCache();
		clearClaudePluginRootsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalPiConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalPiConfigDir;
		}
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	test("isolated settings exclude foreign config agents while preserving native and bundled agents", async () => {
		initializeWithSettings(Settings.isolated({ "compatibility.loadForeignConfig": false }));
		clearClaudePluginRootsCache();

		const { agents } = await discoverAgents(tempProject, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("native-user-agent");
		expect(names).toContain("native-project-agent");
		expect(names).toContain("task");
		expect(names).not.toContain("claude-user-agent");
		expect(names).not.toContain("claude-project-agent");
		expect(names).not.toContain("codex-user-agent");
		expect(names).not.toContain("codex-project-agent");
		expect(names).not.toContain("gemini-user-agent");
		expect(names).not.toContain("gemini-project-agent");
	});

	test("compatibility loadForeignConfig includes foreign config agents", async () => {
		initializeWithSettings(Settings.isolated({ "compatibility.loadForeignConfig": true }));
		clearClaudePluginRootsCache();

		const { agents } = await discoverAgents(tempProject, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("claude-user-agent");
		expect(names).toContain("claude-project-agent");
		expect(names).toContain("codex-user-agent");
		expect(names).toContain("codex-project-agent");
		expect(names).toContain("gemini-user-agent");
		expect(names).toContain("gemini-project-agent");
	});

	test("isolated settings skip Claude marketplace plugin agents without explicitly disabling claude-plugins", async () => {
		initializeWithSettings(Settings.isolated({ "compatibility.loadForeignConfig": false }));
		clearClaudePluginRootsCache();

		const { agents } = await discoverAgents(tempProject, tempHome);
		expect(agents.map(agent => agent.name)).not.toContain("marketplace-plugin-agent");
	});
});

function writeAgent(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), agentFile(name, `${name} description`));
}

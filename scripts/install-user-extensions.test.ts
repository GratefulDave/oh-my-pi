import { afterEach, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installUserExtensions } from "./install-user-extensions";

function expectNoRetiredProviderOutsideDisabled(value: unknown, key = "root"): void {
	if (key === "disabledProviders") return;
	if (typeof value === "string") {
		expect(value.includes("opencode-antigravity"), `${key} contains opencode-antigravity`).toBe(false);
		expect(value.includes("google-antigravity"), `${key} contains google-antigravity`).toBe(false);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) expectNoRetiredProviderOutsideDisabled(item, key);
		return;
	}
	if (value && typeof value === "object") {
		for (const [childKey, childValue] of Object.entries(value)) {
			expectNoRetiredProviderOutsideDisabled(childValue, childKey);
		}
	}
}

describe("install-user-extensions", () => {
	let tempDir = "";

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("preserves Antigravity extension namespace while pruning stale provider selectors", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-install-user-extensions-"));
		const repo = path.join(tempDir, "repo");
		const home = path.join(tempDir, "home");
		const bundleRel = "packages/antigravity/dist/antigravity.bundle.js";
		const bundlePath = path.join(repo, bundleRel);
		const userDir = path.join(home, ".omp", "agent");
		await fs.mkdir(path.dirname(bundlePath), { recursive: true });
		await fs.mkdir(path.join(repo, ".omp"), { recursive: true });
		await fs.mkdir(path.join(repo, "packages"), { recursive: true });
		await fs.mkdir(userDir, { recursive: true });
		await fs.writeFile(bundlePath, "export {};\n");
		await fs.writeFile(
			path.join(repo, ".omp", "settings.json"),
			`${JSON.stringify(
				{
					extensions: [bundleRel],
					activeModelProfile: "antigravity",
					disabledProviders: ["google-antigravity", "opencode-antigravity"],
					enabledModels: ["antigravity/*", "omlx/*"],
					modelProviderOrder: ["antigravity", "omlx"],
					modelRoles: { default: "antigravity/claude-sonnet-4-6" },
					modelProfiles: {
						antigravity: {
							enabledModels: ["antigravity/*", "omlx/*"],
							modelProviderOrder: ["antigravity", "omlx"],
							modelRoles: { default: "antigravity/claude-sonnet-4-6" },
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		await fs.writeFile(
			path.join(userDir, "settings.json"),
			`${JSON.stringify(
				{
					extensions: ["~/.omp/agent/extensions/antigravity-adapter/antigravity.bundle.js"],
					enabledModels: ["opencode-antigravity/*", "google-antigravity/*"],
					modelProviderOrder: ["opencode-antigravity", "google-antigravity"],
					modelRoles: {
						default: "google-antigravity/gemini-pro-agent",
						task: "opencode-antigravity/antigravity-claude-sonnet-4-6",
					},
				},
				null,
				2,
			)}\n`,
		);
		await fs.writeFile(
			path.join(userDir, "config.yml"),
			YAML.stringify({
				extensions: ["~/.omp/agent/extensions/antigravity-adapter/antigravity.bundle.js"],
				enabledModels: ["opencode-antigravity/*", "google-antigravity/*"],
				modelProviderOrder: ["opencode-antigravity", "google-antigravity"],
				modelRoles: {
					default: "google-antigravity/gemini-pro-agent",
					task: "opencode-antigravity/antigravity-claude-sonnet-4-6",
				},
			}),
		);
		await fs.mkdir(path.join(userDir, "extensions", "antigravity-adapter"), { recursive: true });
		await fs.writeFile(path.join(userDir, "extensions", "antigravity-adapter", "antigravity.bundle.js"), "stale");

		await installUserExtensions({ repo, home });

		const settingsJson = JSON.parse(await fs.readFile(path.join(userDir, "settings.json"), "utf8"));
		const configYaml = YAML.parse(await fs.readFile(path.join(userDir, "config.yml"), "utf8")) as Record<string, unknown>;
		for (const config of [settingsJson, configYaml]) {
			expect(config.enabledModels).toContain("antigravity/*");
			expect(config.enabledModels).toContain("omlx/*");
			expect(config.modelRoles).toMatchObject({ default: "antigravity/claude-sonnet-4-6" });
			expect(config.disabledProviders).toEqual(["google-antigravity", "opencode-antigravity"]);
			expect(config.extensions).toEqual(["~/.omp/agent/extensions/antigravity/antigravity.bundle.js"]);
			expectNoRetiredProviderOutsideDisabled(config);
		}
		expect(settingsJson.modelProviderOrder).toContain("antigravity");
		expect(configYaml.modelProviderOrder).toContain("antigravity");
		await expect(fs.lstat(path.join(userDir, "extensions", "antigravity", "antigravity.bundle.js"))).resolves.toBeDefined();
		await expect(fs.lstat(path.join(userDir, "extensions", "antigravity-adapter"))).rejects.toThrow();
	});
});

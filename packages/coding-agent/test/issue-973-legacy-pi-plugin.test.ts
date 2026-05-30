import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadExtensions } from "../src/extensibility/extensions/loader";

describe("issue #973: legacy Pi plugin imports", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@issue-973-");
		const pluginDir = path.join(projectDir.path(), "legacy-pi-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		const retryDir = path.join(pluginDir, "node_modules", "retry");
		fs.mkdirSync(retryDir, { recursive: true });
		fs.writeFileSync(
			path.join(retryDir, "package.json"),
			JSON.stringify({ name: "retry", version: "1.0.0", main: "index" }),
		);
		fs.writeFileSync(
			path.join(retryDir, "index.js"),
			"export default { operation: () => ({ attempt: () => undefined }) };\n",
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "legacy-pi-plugin",
				version: "1.0.0",
				pi: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import { isToolCallEventType as legacyRoot } from "@mariozechner/pi-coding-agent";',
				'import { isToolCallEventType as legacyExtensions } from "@mariozechner/pi-coding-agent/extensibility/extensions";',
				'import retry from "retry";',
				"",
				'if (typeof legacyRoot !== "function") throw new Error("legacy root import did not load");',
				'if (typeof legacyExtensions !== "function") throw new Error("legacy extension import did not load");',
				"",
				"const operation = retry.operation({ retries: 0 });",
				'if (typeof operation.attempt !== "function") throw new Error("extensionless dependency main did not resolve");',
				"",
				"export default function(pi) {",
				'\tpi.registerCommand("legacy-pi-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("loads plugin extensions that still import legacy @mariozechner Pi packages", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toEqual([]);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("legacy-pi-ext")).toBe(true);
	});
});

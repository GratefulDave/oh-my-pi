import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mergeExtensionList, removeStaleManagedDiscoveryFiles } from "./install-user-extensions";

describe("removeStaleManagedDiscoveryFiles", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-extension-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("removes stale manifests and source entrypoints that override a rebuilt bundle", async () => {
		await Promise.all([
			fs.writeFile(path.join(tempDir, "package.json"), "{}\n"),
			fs.writeFile(path.join(tempDir, "index.ts"), "export default null;\n"),
			fs.writeFile(path.join(tempDir, "index.js"), "// keep\n"),
			fs.writeFile(path.join(tempDir, "notes.txt"), "keep\n"),
		]);

		await removeStaleManagedDiscoveryFiles(tempDir, "index.js");

		expect(await Bun.file(path.join(tempDir, "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(tempDir, "index.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(tempDir, "index.js")).exists()).toBe(true);
		expect(await Bun.file(path.join(tempDir, "notes.txt")).text()).toBe("keep\n");
	});
});

it("keeps repo settings free of managed .omp extension bundle duplicates", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const settings = (await Bun.file(path.join(repoRoot, ".omp", "settings.json")).json()) as {
		extensions?: unknown;
	};
	const extensions = Array.isArray(settings.extensions)
		? settings.extensions.filter((value): value is string => typeof value === "string")
		: [];
	expect(
		extensions.filter(entry => /^\.omp\/extensions\/(?!profile-manager\/)[^/]+\/dist\/index\.js$/.test(entry)),
	).toEqual([]);
});

it("preserves user extension registrations under the managed directory", async () => {
	const userExtension = "~/.omp/agent/extensions/user-extension/index.js";
	const registered = "~/.omp/agent/extensions/pi-observer/observer.bundle.js";

	await expect(mergeExtensionList([userExtension], [registered])).resolves.toEqual([userExtension, registered]);
});

it("preserves registration order while replacing a managed extension", async () => {
	const staleManaged = "~/.omp/agent/extensions/pi-observer/old.bundle.js";
	const userExtension = "~/.omp/agent/extensions/user-extension/index.js";
	const registered = "~/.omp/agent/extensions/pi-observer/observer.bundle.js";

	await expect(mergeExtensionList([staleManaged, userExtension], [registered])).resolves.toEqual([
		registered,
		userExtension,
	]);
});

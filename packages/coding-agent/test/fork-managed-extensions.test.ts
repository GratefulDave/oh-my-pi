import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverManagedExtensionSources } from "../../../scripts/fork-managed-extensions";

const tempRepos: string[] = [];

async function makeTempRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lex-managed-ext-"));
	tempRepos.push(repo);
	return repo;
}

describe("discoverManagedExtensionSources", () => {
	afterEach(async () => {
		for (const repo of tempRepos.splice(0)) {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	it("discovers settings, package manifest, and local extension backstop sources in order", async () => {
		const repo = await makeTempRepo();
		await Bun.write(
			path.join(repo, ".omp/settings.json"),
			JSON.stringify({ extensions: ["packages/settings-ext/dist/index.js"] }),
		);
		await Bun.write(
			path.join(repo, "packages/foo/package.json"),
			JSON.stringify({ omp: { extensions: ["dist/foo.js"] } }),
		);
		await Bun.write(path.join(repo, ".omp/extensions/profile-manager/index.ts"), "export {};\n");

		const rels = (await discoverManagedExtensionSources(repo)).map(source => source.rel);

		expect(rels).toEqual([
			"packages/settings-ext/dist/index.js",
			"packages/foo/dist/foo.js",
			".omp/extensions/profile-manager/dist/index.js",
		]);
	});

	it("keeps settings entries when package manifests collide by extension name", async () => {
		const repo = await makeTempRepo();
		await Bun.write(
			path.join(repo, ".omp/settings.json"),
			JSON.stringify({ extensions: ["packages/foo/dist/settings.js"] }),
		);
		await Bun.write(
			path.join(repo, "packages/foo/package.json"),
			JSON.stringify({ omp: { extensions: ["dist/manifest.js"] } }),
		);

		const sources = await discoverManagedExtensionSources(repo);

		expect(sources.map(source => source.rel)).toEqual(["packages/foo/dist/settings.js"]);
		expect(new Set(sources.map(source => source.name)).size).toBe(sources.length);
	});
});

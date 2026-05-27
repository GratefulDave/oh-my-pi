import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { TempDir } from "@oh-my-pi/pi-utils";

import { runFactoryDoctor } from "../../src/factory/doctor";
import { applyFactoryScaffold, buildFactoryScaffoldPlan } from "../../src/factory/scaffold";

describe("software-factory scaffold", () => {
	let tempDir: TempDir;
	let cwd: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@factory-scaffold-");
		cwd = tempDir.path();
		await Bun.write(
			path.join(cwd, "package.json"),
			JSON.stringify({ name: "demo-repo", scripts: { test: "bun test", check: "bun run check" } }, null, 2),
		);
		await Bun.write(path.join(cwd, "AGENTS.md"), "repo guidance\n");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("builds a project-local dry-run plan without touching home scope", async () => {
		const plan = await buildFactoryScaffoldPlan({
			cwd,
			preset: "software-factory",
			dryRun: true,
			existing: false,
			force: false,
			enableMemory: false,
		});
		expect(plan.repoName).toBe(path.basename(cwd));
		expect(plan.repoKind).toContain("javascript");
		expect(plan.memoryBackend).toBe("off");
		expect(plan.files.length).toBeGreaterThan(10);
		expect(plan.files.every(file => file.target.startsWith(cwd))).toBe(true);
		expect(
			plan.files.some(file =>
				file.target.includes(path.join(cwd, ".omp", "extensions", "software-factory", "index.ts")),
			),
		).toBe(true);
		expect(plan.files.some(file => file.target.includes(path.join(cwd, ".omp", "settings.json")))).toBe(false);
	});

	it("writes scaffold files, settings, and imported legacy config inside repo only", async () => {
		await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
		await Bun.write(path.join(cwd, ".claude", "notes.md"), "legacy guidance\n");
		const plan = await applyFactoryScaffold({
			cwd,
			preset: "software-factory",
			dryRun: false,
			existing: true,
			force: false,
			enableMemory: true,
		});
		expect(plan.files.some(file => file.target.endsWith(path.join(".omp", "settings.json")))).toBe(true);
		const factoryConfig = (await Bun.file(path.join(cwd, ".omp", "factory", "factory.json")).json()) as {
			template: { preset: string; version: string };
			repo: { name: string };
		};
		expect(factoryConfig.template.preset).toBe("software-factory");
		expect(factoryConfig.template.version.length).toBeGreaterThan(0);
		expect(factoryConfig.repo.name).toBe(path.basename(cwd));
		const settings = (await Bun.file(path.join(cwd, ".omp", "settings.json")).json()) as {
			memory: { backend: string };
		};
		expect(settings.memory.backend).toBe("icm");
		expect(await Bun.file(path.join(cwd, ".omp", "factory", "imported", ".claude", "notes.md")).exists()).toBe(true);
		expect(await Bun.file(path.join(cwd, ".omp", "factory", "imported", "import-report.json")).exists()).toBe(true);
		const doctor = await runFactoryDoctor(cwd);
		expect(doctor.ok).toBe(true);
	});

	it("flags invalid workflow json during doctor run", async () => {
		await applyFactoryScaffold({
			cwd,
			preset: "standard",
			dryRun: false,
			existing: false,
			force: false,
			enableMemory: false,
		});
		await Bun.write(
			path.join(cwd, ".omp", "factory", "workflows", "piter.json"),
			JSON.stringify({ name: "broken", steps: [] }, null, 2),
		);
		const doctor = await runFactoryDoctor(cwd);
		expect(doctor.ok).toBe(false);
		expect(doctor.checks.some(check => check.kind === "workflow" && check.ok === false)).toBe(true);
	});
});

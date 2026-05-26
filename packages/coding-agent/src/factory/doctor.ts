import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@oh-my-pi/pi-utils";

import { getSoftwareFactoryManifest } from "./template-manifest";

export interface FactoryDoctorCheck {
	kind: "file" | "config" | "workflow" | "safety" | "path";
	ok: boolean;
	message: string;
	path?: string;
}

export interface FactoryDoctorResult {
	ok: boolean;
	checks: FactoryDoctorCheck[];
}

interface FactoryConfigShape {
	template?: { version?: string; preset?: string };
	verifier?: { systemPrompt?: string; prompt?: string; oracle?: string };
	safety?: { rulesPath?: string };
	metaPrompt?: { prompt?: string };
	workflow?: { default?: string };
}

interface WorkflowShape {
	name?: string;
	maxLoops?: number;
	steps?: Array<{ id?: string; agent?: string; prompt?: string }>;
}

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.stat(targetPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readJson<T>(filePath: string): Promise<T> {
	return (await Bun.file(filePath).json()) as T;
}

function insideRepo(cwd: string, candidatePath: string): boolean {
	const resolvedCwd = path.resolve(cwd);
	const resolved = path.resolve(candidatePath);
	return resolved === resolvedCwd || resolved.startsWith(`${resolvedCwd}${path.sep}`);
}

export async function runFactoryDoctor(cwd: string): Promise<FactoryDoctorResult> {
	const checks: FactoryDoctorCheck[] = [];
	const manifest = getSoftwareFactoryManifest();
	for (const entry of manifest.files) {
		if (entry.target === ".omp/settings.json") continue;
		const targetPath = path.join(cwd, entry.target);
		checks.push({
			kind: "file",
			ok: await exists(targetPath),
			message: `${entry.target}${(await exists(targetPath)) ? " present" : " missing"}`,
			path: targetPath,
		});
	}

	const factoryPath = path.join(cwd, ".omp", "factory", "factory.json");
	if (!(await exists(factoryPath))) {
		checks.push({ kind: "config", ok: false, message: "Missing .omp/factory/factory.json", path: factoryPath });
		return { ok: false, checks };
	}

	const config = await readJson<FactoryConfigShape>(factoryPath);
	checks.push({
		kind: "config",
		ok: typeof config.template?.version === "string" && typeof config.template?.preset === "string",
		message: "Factory config template metadata parsed",
		path: factoryPath,
	});

	for (const relativePath of [
		config.verifier?.systemPrompt,
		config.verifier?.prompt,
		config.verifier?.oracle,
		config.metaPrompt?.prompt,
	]) {
		if (!relativePath) continue;
		const resolved = path.resolve(path.join(cwd, ".omp", "factory"), relativePath);
		checks.push({
			kind: "path",
			ok: insideRepo(cwd, resolved),
			message: insideRepo(cwd, resolved) ? `Repo-scoped path OK: ${relativePath}` : `Path escapes repo: ${relativePath}`,
			path: resolved,
		});
	}

	const safetyPath = path.resolve(path.join(cwd, ".omp", "factory"), config.safety?.rulesPath ?? "safety.rules.json");
	if (await exists(safetyPath)) {
		const safety = await readJson<{ version?: number; rules?: Array<{ id?: string }> }>(safetyPath);
		checks.push({
			kind: "safety",
			ok: typeof safety.version === "number" && Array.isArray(safety.rules),
			message: "Safety rules parsed",
			path: safetyPath,
		});
	} else {
		checks.push({ kind: "safety", ok: false, message: "Safety rules missing", path: safetyPath });
	}

	const workflowsDir = path.join(cwd, ".omp", "factory", "workflows");
	if (await exists(workflowsDir)) {
		for (const entry of await fs.readdir(workflowsDir)) {
			if (!entry.endsWith(".json")) continue;
			const workflowPath = path.join(workflowsDir, entry);
			const workflow = await readJson<WorkflowShape>(workflowPath);
			const valid =
				typeof workflow.name === "string" &&
				typeof workflow.maxLoops === "number" &&
				Array.isArray(workflow.steps) &&
				workflow.steps.every(step => typeof step.id === "string" && typeof step.agent === "string" && typeof step.prompt === "string");
			checks.push({
				kind: "workflow",
				ok: valid,
				message: `Workflow ${entry} ${valid ? "parsed" : "invalid"}`,
				path: workflowPath,
			});
		}
	}

	return { ok: checks.every(check => check.ok), checks };
}

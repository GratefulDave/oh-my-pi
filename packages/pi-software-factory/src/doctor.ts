import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@oh-my-pi/pi-utils";

export interface FactoryDoctorCheck {
	kind: "file" | "config" | "path";
	ok: boolean;
	message: string;
	path?: string;
}

export interface FactoryDoctorResult {
	ok: boolean;
	checks: FactoryDoctorCheck[];
}

const REQUIRED_FILES = [".omp/factory/factory.json", ".omp/factory/safety.rules.json", ".omp/settings.json"];
const RECOMMENDED_FILES = [
	".omp/factory/runs",
	".omp/factory/scripts/verify.sh",
	".omp/factory/prompts/meta-prompt.md",
	".omp/factory/prompts/verify-on-stop.md",
	".omp/factory/prompts/claude-main-orchestrator.md",
	".omp/factory/prompts/omp-main-orchestrator.md",
	".omp/agents/factory-verifier.md",
];

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readJson<T>(filePath: string): Promise<T> {
	return (await Bun.file(filePath).json()) as T;
}

interface FactoryConfig {
	template?: { version?: string; preset?: string };
	verifier?: { enabled?: boolean; tools?: string[] };
	safety?: { enabled?: boolean; rulesPath?: string };
	metaPrompt?: { enabled?: boolean; prompt?: string };
	workflow?: { enabled?: boolean; default?: string };
	memory?: { captureCandidates?: boolean };
	paneWorker?: {
		enabled?: boolean;
		backend?: string;
		claudeCommand?: string;
		orchestratorDefault?: string;
		workerRuntime?: string;
	};
}

export async function runFactoryDoctor(cwd: string): Promise<FactoryDoctorResult> {
	const checks: FactoryDoctorCheck[] = [];
	for (const file of REQUIRED_FILES) {
		const fileExists = await exists(path.join(cwd, file));
		checks.push({
			kind: "file",
			ok: fileExists,
			message: fileExists ? `${file} exists` : `${file} MISSING`,
			path: file,
		});
	}
	for (const file of RECOMMENDED_FILES) {
		const fileExists = await exists(path.join(cwd, file));
		checks.push({
			kind: "file",
			ok: fileExists,
			message: fileExists ? `${file} exists` : `${file} missing (recommended)`,
			path: file,
		});
	}

	const factoryPath = path.join(cwd, ".omp/factory/factory.json");
	try {
		const config = await readJson<FactoryConfig>(factoryPath);
		for (const field of ["template", "verifier", "safety"] as const) {
			const hasField = config[field] !== undefined;
			checks.push({
				kind: "config",
				ok: hasField,
				message: hasField ? `factory.json has "${field}" section` : `factory.json MISSING "${field}" section`,
				path: ".omp/factory/factory.json",
			});
		}
		if (config.safety?.rulesPath) {
			const rulesExist = await exists(path.join(cwd, ".omp/factory", config.safety.rulesPath));
			checks.push({
				kind: "config",
				ok: rulesExist,
				message: rulesExist
					? `safety rules file (${config.safety.rulesPath}) exists`
					: `safety rules file (${config.safety.rulesPath}) MISSING`,
				path: config.safety.rulesPath,
			});
		}
		if (config.paneWorker?.enabled) {
			checks.push({
				kind: "config",
				ok: config.paneWorker.backend === "cmux",
				message:
					config.paneWorker.backend === "cmux"
						? 'paneWorker backend is "cmux"'
						: 'paneWorker backend must be "cmux"',
				path: ".omp/factory/factory.json",
			});
			checks.push({
				kind: "config",
				ok: config.paneWorker.workerRuntime === "claude",
				message:
					config.paneWorker.workerRuntime === "claude"
						? 'paneWorker workerRuntime is "claude"'
						: 'paneWorker workerRuntime must be "claude"',
				path: ".omp/factory/factory.json",
			});
			checks.push({
				kind: "config",
				ok: typeof config.paneWorker.claudeCommand === "string" && config.paneWorker.claudeCommand.length > 0,
				message:
					typeof config.paneWorker.claudeCommand === "string" && config.paneWorker.claudeCommand.length > 0
						? "paneWorker claudeCommand is configured"
						: "paneWorker claudeCommand must be a non-empty string",
				path: ".omp/factory/factory.json",
			});
		}
	} catch {
		checks.push({
			kind: "config",
			ok: false,
			message: "factory.json is invalid or unreadable",
			path: ".omp/factory/factory.json",
		});
	}

	const verifyScriptPath = path.join(cwd, ".omp/factory/scripts/verify.sh");
	try {
		if (await Bun.file(verifyScriptPath).exists()) {
			checks.push({
				kind: "path",
				ok: true,
				message: "verify.sh exists",
				path: ".omp/factory/scripts/verify.sh",
			});
		}
	} catch {
		checks.push({
			kind: "path",
			ok: false,
			message: "verify.sh is missing or not readable",
			path: ".omp/factory/scripts/verify.sh",
		});
	}

	const ok = checks.every(check => check.ok || check.message.endsWith("(recommended)"));
	return { ok, checks };
}

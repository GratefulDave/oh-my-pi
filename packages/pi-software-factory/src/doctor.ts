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
	".omp/factory/scripts/verify.sh",
	".omp/factory/prompts/meta-prompt.md",
	".omp/factory/prompts/verify-on-stop.md",
	".omp/agents/factory-verifier.md",
];

async function exists(filePath: string): Promise<boolean> {
	try {
		await Bun.file(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
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
}

export async function runFactoryDoctor(cwd: string): Promise<FactoryDoctorResult> {
	const checks: FactoryDoctorCheck[] = [];

	// Check required files exist
	for (const file of REQUIRED_FILES) {
		const filePath = path.join(cwd, file);
		const fileExists = await exists(filePath);
		checks.push({
			kind: "file",
			ok: fileExists,
			message: fileExists ? `${file} exists` : `${file} MISSING`,
			path: file,
		});
	}

	// Check recommended files
	for (const file of RECOMMENDED_FILES) {
		const filePath = path.join(cwd, file);
		const fileExists = await exists(filePath);
		checks.push({
			kind: "file",
			ok: fileExists,
			message: fileExists ? `${file} exists` : `${file} missing (recommended)`,
			path: file,
		});
	}

	// Validate factory.json structure
	const factoryPath = path.join(cwd, ".omp/factory/factory.json");
	try {
		const config = await readJson<FactoryConfig>(factoryPath);
		const requiredFields = ["template", "verifier", "safety"] as const;
		for (const field of requiredFields) {
			const hasField = config[field] !== undefined;
			checks.push({
				kind: "config",
				ok: hasField,
				message: hasField ? `factory.json has "${field}" section` : `factory.json MISSING "${field}" section`,
				path: ".omp/factory/factory.json",
			});
		}

		// Check safety rulesPath resolves
		if (config.safety?.rulesPath) {
			const rulesPath = path.join(cwd, ".omp/factory", config.safety.rulesPath);
			const rulesExist = await exists(rulesPath);
			checks.push({
				kind: "config",
				ok: rulesExist,
				message: rulesExist
					? `safety rules file (${config.safety.rulesPath}) exists`
					: `safety rules file (${config.safety.rulesPath}) MISSING`,
				path: config.safety.rulesPath,
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

	// Check verify.sh is executable
	const oraclePath = path.join(cwd, ".omp/factory/scripts/verify.sh");
	try {
		const stat = !!(await Bun.file(oraclePath).exists());
		if (stat) {
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

	const ok = checks.every(c => c.ok);
	return { ok, checks };
}

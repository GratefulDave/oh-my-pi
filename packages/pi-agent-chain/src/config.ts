import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

const CONFIG_DIR = path.join(".omp", "agent", "chain");
const CONFIG_NAMES = ["config.yml", "config.yaml"] as const;

export interface ChainTaskConfig {
	agent: string;
	assignment: string;
	id?: string;
	role?: string;
	description?: string;
	taskGroup?: string;
}

export interface ChainDefinition {
	id: string;
	description?: string;
	teamGroup?: string;
	taskGroup?: string;
	context?: string;
	systemPrompt?: string;
	tasks: ChainTaskConfig[];
}

export interface ChainRegistry {
	taskGroups: Record<string, string>;
	chains: Record<string, ChainDefinition>;
	loadedFiles: string[];
}

type ChainConfigFile = {
	sharedTaskGroups: Record<string, string>;
	chains: Record<string, ChainDefinition>;
	loadedFiles: string[];
};

export async function loadChainRegistry(cwd: string, options?: { homeDir?: string }): Promise<ChainRegistry> {
	const homeDir = options?.homeDir ?? process.env.HOME;
	const homeConfig = homeDir ? await loadConfigDir(path.join(homeDir, CONFIG_DIR)) : emptyConfig();
	const localConfig = await loadConfigDir(path.join(cwd, CONFIG_DIR));
	return mergeConfigs(homeConfig, localConfig);
}

export function getChain(registry: ChainRegistry, chainId: string): ChainDefinition | undefined {
	return registry.chains[chainId];
}

async function loadConfigDir(configDir: string): Promise<ChainConfigFile> {
	for (const name of CONFIG_NAMES) {
		const filePath = path.join(configDir, name);
		const parsed = await readConfigFile(filePath);
		if (parsed) return parsed;
	}
	return emptyConfig();
}

async function readConfigFile(filePath: string): Promise<ChainConfigFile | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const parsed = YAML.parse(raw);
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Chain config ${filePath} must contain a YAML object.`);
	}
	return normalizeConfigFile(filePath, parsed as Record<string, unknown>);
}

function normalizeConfigFile(filePath: string, raw: Record<string, unknown>): ChainConfigFile {
	const sharedTaskGroups = normalizeStringMap(
		raw.shared_task_groups ?? raw.sharedTaskGroups,
		`${filePath}:shared_task_groups`,
	);
	const rawChains = raw.chains;
	if (rawChains !== undefined && !isRecord(rawChains)) {
		throw new Error(`Chain config ${filePath} field 'chains' must be a mapping.`);
	}
	const chains: Record<string, ChainDefinition> = {};
	for (const [chainId, value] of Object.entries(rawChains ?? {})) {
		chains[chainId] = normalizeChain(filePath, chainId, value);
	}
	return { sharedTaskGroups, chains, loadedFiles: [filePath] };
}

function normalizeChain(filePath: string, chainId: string, raw: unknown): ChainDefinition {
	if (!isRecord(raw)) {
		throw new Error(`Chain config ${filePath} chain '${chainId}' must be a mapping.`);
	}
	const rawTasks = raw.tasks;
	if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
		throw new Error(`Chain config ${filePath} chain '${chainId}' must define a non-empty tasks array.`);
	}
	return {
		id: chainId,
		description: readOptionalString(raw.description),
		teamGroup: readOptionalString(raw.team_group ?? raw.teamGroup),
		taskGroup: readOptionalString(raw.task_group ?? raw.taskGroup),
		context: readOptionalString(raw.context),
		systemPrompt: readOptionalString(raw.system_prompt ?? raw.systemPrompt),
		tasks: rawTasks.map((task, index) => normalizeTask(filePath, chainId, index, task)),
	};
}

function normalizeTask(filePath: string, chainId: string, index: number, raw: unknown): ChainTaskConfig {
	if (!isRecord(raw)) {
		throw new Error(`Chain config ${filePath} chain '${chainId}' task ${index + 1} must be a mapping.`);
	}
	const agent = readRequiredString(raw.agent, `${filePath} chain '${chainId}' task ${index + 1} field 'agent'`);
	const assignment = readRequiredString(
		raw.assignment,
		`${filePath} chain '${chainId}' task ${index + 1} field 'assignment'`,
	);
	return {
		agent,
		assignment,
		id: readOptionalString(raw.id),
		role: readOptionalString(raw.role),
		description: readOptionalString(raw.description),
		taskGroup: readOptionalString(raw.task_group ?? raw.taskGroup),
	};
}

function mergeConfigs(base: ChainConfigFile, local: ChainConfigFile): ChainRegistry {
	const chains: Record<string, ChainDefinition> = { ...base.chains };
	for (const [chainId, localChain] of Object.entries(local.chains)) {
		const baseChain = chains[chainId];
		chains[chainId] = baseChain
			? {
					id: baseChain.id,
					description: localChain.description ?? baseChain.description,
					teamGroup: localChain.teamGroup ?? baseChain.teamGroup,
					taskGroup: localChain.taskGroup ?? baseChain.taskGroup,
					context: localChain.context ?? baseChain.context,
					systemPrompt: localChain.systemPrompt ?? baseChain.systemPrompt,
					tasks: localChain.tasks.length > 0 ? localChain.tasks : baseChain.tasks,
				}
			: localChain;
	}
	return {
		taskGroups: { ...base.sharedTaskGroups, ...local.sharedTaskGroups },
		chains,
		loadedFiles: [...base.loadedFiles, ...local.loadedFiles],
	};
}

function emptyConfig(): ChainConfigFile {
	return { sharedTaskGroups: {}, chains: {}, loadedFiles: [] };
}

function normalizeStringMap(raw: unknown, label: string): Record<string, string> {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		throw new Error(`Chain config ${label} must be a mapping of strings.`);
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		out[key] = readRequiredString(value, `${label}.${key}`);
	}
	return out;
}

function readRequiredString(value: unknown, label: string): string {
	if (typeof value === "string" && value.trim().length > 0) return value;
	throw new Error(`${label} must be a non-empty string.`);
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

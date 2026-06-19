import { type ChainDefinition, type ChainRegistry, type ChainTaskConfig, getChain, loadChainRegistry } from "./config";
import { renderChainTemplate } from "./template";

export type TaskItem = {
	agent: string;
	id?: string;
	role?: string;
	description?: string;
	assignment: string;
};

export type TaskParams = {
	agent: "task";
	context?: string;
	tasks: TaskItem[];
};

export type TaskToolDetails = {
	projectAgentsDir: string | null;
	results: unknown[];
	totalDurationMs: number;
	[key: string]: unknown;
};

type ZodLike = {
	object(shape: Record<string, unknown>): unknown;
	string(): { describe(description: string): unknown };
};

export type ExtensionContext = {
	cwd: string;
	runTask?: (
		params: TaskParams,
		options?: {
			toolCallId?: string;
			signal?: AbortSignal;
			onUpdate?: (update: { content: unknown[]; details?: TaskToolDetails }) => Promise<void> | void;
		},
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: TaskToolDetails }>;
};

export type ExtensionAPI = {
	zod: ZodLike;
	setLabel(label: string): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(
			toolCallId: string,
			params: RunChainParams,
			signal: AbortSignal | undefined,
			onUpdate: ((update: { content: unknown[]; details?: TaskToolDetails }) => Promise<void> | void) | undefined,
			ctx: ExtensionContext,
		): Promise<{ content: Array<{ type: string; text: string }>; details?: ChainToolDetails }>;
	}): void;
	on(
		event: "before_agent_start",
		handler: (
			event: { prompt: string; systemPrompt: string[] },
			ctx: ExtensionContext,
		) => Promise<{ systemPrompt: string[] } | undefined> | { systemPrompt: string[] } | undefined,
	): void;
};

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `
Chain "{{chain.id}}" is active for this turn.
{{#if chain.description}}
Description: {{chain.description}}
{{/if}}
When the request fits this chain, prefer the run_chain tool with chainId "{{chain.id}}".
{{#if request}}
Current request: {{request}}
{{/if}}
Configured subagents:
{{#each tasks}}
- {{agent}}{{#if role}} ({{role}}){{/if}}: {{summary}}
{{/each}}
`;

const TASK_UNAVAILABLE_ERROR = "Task tool is not available in this session.";

type RunChainParams = {
	chainId: string;
	request: string;
};

type ChainToolDetails = TaskToolDetails & {
	activeChain: string;
	teamGroup: string;
	loadedFiles: string[];
};

type ChainPromptMatch = {
	chainId: string;
	request?: string;
};

export default function agentChain(pi: ExtensionAPI): void {
	const z = pi.zod;
	let activeChainId: string | undefined;

	pi.setLabel("Agent Chain");

	pi.registerTool({
		name: "run_chain",
		label: "Run Chain",
		description: "Run a configured task chain through the host task tool",
		parameters: z.object({
			chainId: z.string().describe("Configured chain id to run"),
			request: z.string().describe("User request to route through the chain"),
		}),
		async execute(
			toolCallId: string,
			params: RunChainParams,
			signal: AbortSignal | undefined,
			onUpdate,
			ctx: ExtensionContext,
		) {
			const registry = await loadChainRegistry(ctx.cwd);
			const chain = getChain(registry, params.chainId);
			if (!chain) throw new Error(`Unknown chain '${params.chainId}'.`);
			const runTask = ctx.runTask;
			if (typeof runTask !== "function") {
				throw new Error(TASK_UNAVAILABLE_ERROR);
			}

			activeChainId = chain.id;
			const taskParams = buildTaskParams(chain, registry, params.request, ctx.cwd);
			const result = await runTask(taskParams, {
				toolCallId,
				signal,
				onUpdate: async update => {
					if (!onUpdate) return;
					await onUpdate({
						...update,
						details: addChainMetadata(update.details, chain, registry),
					});
				},
			});
			return {
				...result,
				details: addChainMetadata(result.details, chain, registry),
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const registry = await loadChainRegistry(ctx.cwd);
		const promptMatch = parseChainPrompt(event.prompt, registry);
		const requestedChainId = promptMatch?.chainId ?? activeChainId;
		if (!requestedChainId) return;
		const chain = getChain(registry, requestedChainId);
		if (!chain) return;

		activeChainId = chain.id;
		const injected = buildInjectedPrompt(chain, registry, promptMatch?.request ?? event.prompt, ctx.cwd);
		return {
			systemPrompt: [...event.systemPrompt, injected],
		};
	});
}

function buildTaskParams(chain: ChainDefinition, registry: ChainRegistry, request: string, cwd: string): TaskParams {
	const data = buildTemplateData(chain, request, cwd);
	const contextSections: string[] = [];
	if (chain.taskGroup) {
		const shared = registry.taskGroups[chain.taskGroup];
		if (!shared) throw new Error(`Chain '${chain.id}' references missing task group '${chain.taskGroup}'.`);
		contextSections.push(renderChainTemplate(shared, data).trim());
	}
	if (chain.context) {
		contextSections.push(renderChainTemplate(chain.context, data).trim());
	}

	return {
		agent: "task",
		context: contextSections.filter(Boolean).join("\n\n"),
		tasks: chain.tasks.map(task => buildTaskItem(chain, registry, task, data)),
	};
}

function buildTaskItem(
	chain: ChainDefinition,
	registry: ChainRegistry,
	task: ChainTaskConfig,
	data: Record<string, unknown>,
): TaskItem {
	const sections = [`Chain: ${chain.id}`];
	const taskGroupName = task.taskGroup;
	if (taskGroupName) {
		const shared = registry.taskGroups[taskGroupName];
		if (!shared)
			throw new Error(
				`Chain '${chain.id}' task '${task.id ?? task.agent}' references missing task group '${taskGroupName}'.`,
			);
		sections.push(renderChainTemplate(shared, data).trim());
	}
	sections.push(renderChainTemplate(task.assignment, data).trim());
	return {
		agent: task.agent,
		id: task.id,
		role: task.role,
		description: task.description,
		assignment: sections.filter(Boolean).join("\n\n"),
	};
}

function buildInjectedPrompt(chain: ChainDefinition, registry: ChainRegistry, request: string, cwd: string): string {
	const data = buildTemplateData(chain, request, cwd, registry.loadedFiles);
	if (chain.systemPrompt) return renderChainTemplate(chain.systemPrompt, data).trim();
	return renderChainTemplate(DEFAULT_SYSTEM_PROMPT_TEMPLATE, data).trim();
}

function buildTemplateData(
	chain: ChainDefinition,
	request: string,
	cwd: string,
	loadedFiles?: string[],
): Record<string, unknown> {
	return {
		chainId: chain.id,
		request,
		cwd,
		chain,
		loadedFiles,
		tasks: chain.tasks.map(task => ({
			...task,
			summary: task.description ?? task.assignment,
		})),
	};
}

function addChainMetadata(
	details: TaskToolDetails | undefined,
	chain: ChainDefinition,
	registry: ChainRegistry,
): ChainToolDetails {
	const base =
		details && typeof details === "object" ? details : { projectAgentsDir: null, results: [], totalDurationMs: 0 };
	return {
		...base,
		activeChain: chain.id,
		teamGroup: chain.teamGroup ?? chain.id,
		loadedFiles: registry.loadedFiles,
	};
}

function parseChainPrompt(prompt: string, registry: ChainRegistry): ChainPromptMatch | undefined {
	const match = prompt.match(/(?:^|\s)\/chain\s+([A-Za-z0-9._-]+)(?:\s+([\s\S]+))?$/);
	if (match) {
		const chainId = match[1];
		if (chainId && registry.chains[chainId]) {
			return { chainId, request: match[2]?.trim() };
		}
	}
	const inlineMatch = prompt.match(/\bchain:([A-Za-z0-9._-]+)\b/);
	if (inlineMatch?.[1] && registry.chains[inlineMatch[1]]) {
		return { chainId: inlineMatch[1] };
	}
	return undefined;
}

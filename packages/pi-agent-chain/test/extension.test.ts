import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod/v4";
import { loadChainRegistry } from "../src/config";
import agentChain, { type ExtensionAPI, type ExtensionContext } from "../src/index";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: { chainId: string; request: string },
		signal: AbortSignal | undefined,
		onUpdate: ((update: { details?: Record<string, unknown> }) => Promise<void> | void) | undefined,
		ctx: ExtensionContext,
	) => Promise<{ details?: Record<string, unknown>; content: Array<{ type: string; text: string }> }>;
};
type BeforeAgentStartHandler = (
	event: { prompt: string; systemPrompt: string[] },
	ctx: ExtensionContext,
) => Promise<unknown>;

async function makeTempDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function writeYaml(root: string, relativePath: string, content: string): Promise<void> {
	const target = path.join(root, relativePath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
}

function createApi() {
	let registeredTool: RegisteredTool | undefined;
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	const api = {
		zod: z,
		setLabel() {},
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		on(event: string, handler: BeforeAgentStartHandler) {
			if (event === "before_agent_start") beforeAgentStart = handler;
		},
	} as unknown as ExtensionAPI;
	return {
		api,
		getTool() {
			if (!registeredTool) throw new Error("run_chain tool not registered");
			return registeredTool;
		},
		getBeforeAgentStart() {
			if (!beforeAgentStart) throw new Error("before_agent_start hook not registered");
			return beforeAgentStart;
		},
	};
}

describe("pi-agent-chain", () => {
	it("merges shared task groups with local chain overrides", async () => {
		const homeDir = await makeTempDir("chain-home");
		const cwd = await makeTempDir("chain-cwd");
		await writeYaml(
			homeDir,
			".omp/agent/chain/config.yml",
			[
				"shared_task_groups:",
				"  research: |",
				"    Shared context for {{request}}",
				"chains:",
				"  docs:",
				"    description: Shared docs chain",
				"    tasks:",
				"      - agent: explore",
				"        assignment: Investigate {{request}}",
			].join("\n"),
		);
		await writeYaml(
			cwd,
			".omp/agent/chain/config.yml",
			[
				"shared_task_groups:",
				"  local: |",
				"    Local override for {{chainId}}",
				"chains:",
				"  docs:",
				"    team_group: docs-team",
				"    tasks:",
				"      - agent: reviewer",
				"        assignment: Review {{request}}",
			].join("\n"),
		);

		const registry = await loadChainRegistry(cwd, { homeDir });

		expect(registry.taskGroups.research).toContain("Shared context");
		expect(registry.taskGroups.local).toContain("Local override");
		expect(registry.chains.docs?.description).toBe("Shared docs chain");
		expect(registry.chains.docs?.teamGroup).toBe("docs-team");
		expect(registry.chains.docs?.tasks.map(task => task.agent)).toEqual(["reviewer"]);
		expect(registry.loadedFiles).toHaveLength(2);
	});

	it("runs a configured chain through ctx.runTask and forwards chain metadata", async () => {
		const homeDir = await makeTempDir("chain-home");
		const cwd = await makeTempDir("chain-cwd");
		await writeYaml(
			homeDir,
			".omp/agent/chain/config.yml",
			[
				"shared_task_groups:",
				"  research: |",
				"    Shared block for {{request}}",
				"chains:",
				"  docs:",
				"    team_group: docs-team",
				"    context: |",
				"      Context for {{request}}",
				"    tasks:",
				"      - id: Planner",
				"        agent: task",
				"        role: Planner",
				"        task_group: research",
				"        assignment: Plan {{request}}",
			].join("\n"),
		);
		process.env.HOME = homeDir;

		const { api, getTool } = createApi();
		agentChain(api);
		const tool = getTool();
		const updates: Array<Record<string, unknown> | undefined> = [];
		let runTaskParams: Record<string, unknown> | undefined;
		const result = await tool.execute(
			"tc-run-chain",
			{ chainId: "docs", request: "trace regression" },
			undefined,
			update => {
				updates.push(update.details);
			},
			{
				cwd,
				runTask: async (
					params: unknown,
					options: {
						onUpdate?:
							| ((update: { details?: Record<string, unknown>; content: unknown[] }) => Promise<void> | void)
							| undefined;
					},
				) => {
					runTaskParams = params as Record<string, unknown>;
					await options?.onUpdate?.({
						details: { projectAgentsDir: null, results: [], totalDurationMs: 1 },
						content: [],
					});
					return {
						content: [{ type: "text", text: "All done." }],
						details: { projectAgentsDir: null, results: [], totalDurationMs: 3 },
					};
				},
			} as unknown as ExtensionContext,
		);
		expect(runTaskParams).toMatchObject({ agent: "task" });
		expect(String(runTaskParams?.context)).toContain("Context for trace regression");
		expect(Array.isArray(runTaskParams?.tasks)).toBe(true);
		expect(String((runTaskParams?.tasks as Array<Record<string, unknown>>)[0]?.assignment)).toContain("Chain: docs");
		expect(String((runTaskParams?.tasks as Array<Record<string, unknown>>)[0]?.assignment)).toContain(
			"Shared block for trace regression",
		);
		expect(updates[0]?.activeChain).toBe("docs");
		expect(updates[0]?.teamGroup).toBe("docs-team");
		expect(result.details?.activeChain).toBe("docs");
		expect(result.details?.teamGroup).toBe("docs-team");
	});

	it("injects chain prompt on before_agent_start and preserves unavailable task errors", async () => {
		const homeDir = await makeTempDir("chain-home");
		const cwd = await makeTempDir("chain-cwd");
		await writeYaml(
			homeDir,
			".omp/agent/chain/config.yml",
			[
				"chains:",
				"  docs:",
				"    description: Docs lane",
				"    system_prompt: |",
				"      Chain {{chain.id}} for {{request}}",
				"    tasks:",
				"      - agent: task",
				"        assignment: Review {{request}}",
			].join("\n"),
		);
		process.env.HOME = homeDir;

		const { api, getBeforeAgentStart, getTool } = createApi();
		agentChain(api);

		const beforeAgentStart = getBeforeAgentStart();
		const beforeResult = (await beforeAgentStart(
			{ prompt: "/chain docs write release notes", systemPrompt: ["base"] },
			{ cwd } as ExtensionContext,
		)) as { systemPrompt?: string[] } | undefined;
		expect(beforeResult?.systemPrompt?.at(-1)).toContain("Chain docs for write release notes");

		const tool = getTool();
		await expect(
			tool.execute("tc-unavailable", { chainId: "docs", request: "write release notes" }, undefined, undefined, {
				cwd,
			} as ExtensionContext),
		).rejects.toThrow("Task tool is not available in this session.");
	});
});

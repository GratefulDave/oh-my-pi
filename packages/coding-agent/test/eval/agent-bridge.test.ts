import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import * as taskDiscovery from "../../src/task/discovery";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Do work.",
	source: "bundled",
};

const okResult: SingleResult = {
	index: 0,
	id: "EvalAgent",
	agent: "task",
	agentSource: "bundled",
	task: "task",
	assignment: "inspect",
	exitCode: 0,
	output: "done",
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 0,
	usage: {
		input: 0,
		output: 17,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 17,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/eval-agent-test",
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.mode": "none" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		...overrides,
	} as ToolSession;
}

describe("eval agent bridge", () => {
	afterEach(() => {
		spyOn(taskDiscovery, "discoverAgents").mockRestore();
		spyOn(taskExecutor, "runSubprocess").mockRestore();
	});

	it("dispatches a subagent and returns final output", async () => {
		spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const run = spyOn(taskExecutor, "runSubprocess").mockResolvedValue(okResult);
		const usage: number[] = [];

		const result = await runEvalAgent(
			{ prompt: "inspect", label: "demo" },
			{ session: makeSession({ recordEvalSubagentUsage: output => usage.push(output) }) },
		);

		expect(result).toEqual({
			text: "done",
			details: { agent: "task", id: "EvalAgent", model: [], structured: false },
		});
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ assignment: "inspect", description: "demo" }));
		expect(usage).toEqual([17]);
	});

	it("blocks hard budget exhaustion before spawning", async () => {
		spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const run = spyOn(taskExecutor, "runSubprocess").mockResolvedValue(okResult);

		await expect(
			runEvalAgent(
				{ prompt: "inspect" },
				{ session: makeSession({ getTurnBudget: () => ({ total: 10, spent: 10, hard: true }) }) },
			),
		).rejects.toThrow("turn token budget exhausted");
		expect(run).not.toHaveBeenCalled();
	});
});

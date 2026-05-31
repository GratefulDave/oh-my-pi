/**
 * Swarm agent execution via oh-my-pi's subagent infrastructure.
 *
 * Wraps `runSubprocess` to spawn individual swarm agents with full tool access.
 * Each agent runs in the swarm workspace with its task instructions as the user prompt.
 */
import * as path from "node:path";
import {
	ActorOrchestrator,
	type AgentDefinition,
	type AgentProgress,
	type AgentSource,
	type AuthStorage,
	type ModelRegistry,
	type Settings,
	type SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import type { SwarmAgent } from "./schema";
import type { StateTracker } from "./state";
import type { RunSubprocessFn } from "./types";

export interface SwarmExecutorOptions {
	workspace: string;
	swarmName: string;
	iteration: number;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (agentName: string, progress: AgentProgress) => void;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	stateTracker: StateTracker;
	/** Injected runSubprocess — avoids runtime @oh-my-pi/* import in compiled binary. */
	runSubprocess: RunSubprocessFn;
}

/**
 * Execute a single swarm agent as an oh-my-pi subagent.
 *
 * The agent receives:
 * - System prompt: built from role + extra_context
 * - User prompt (task): the full task instructions from the YAML
 * - Working directory: the swarm workspace
 * - Full tool access (bash, python, read, write, edit, grep, find, fetch, web_search, browser)
 */
export async function executeSwarmAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
): Promise<SingleResult> {
	const {
		workspace,
		swarmName,
		iteration,
		modelOverride,
		signal,
		onProgress,
		authStorage,
		modelRegistry,
		settings,
		stateTracker,
		runSubprocess,
	} = options;

	const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`;
	const actorOrchestrator = new ActorOrchestrator();
	actorOrchestrator.plan({
		id: agentId,
		agentName: agent.name,
		assignment: agent.task,
		description: `Swarm agent: ${agent.role}`,
	});

	const agentDef: AgentDefinition = {
		name: agent.name,
		description: `Swarm agent: ${agent.role}`,
		systemPrompt: buildSystemPrompt(agent),
		source: "project" as AgentSource,
	};

	await stateTracker.updateAgent(agent.name, {
		status: "running",
		iteration,
		startedAt: Date.now(),
	});
	await stateTracker.appendEvent({
		type: "agent.start",
		channel: "pipeline",
		agent: agent.name,
		iteration,
		status: "running",
		message: `Starting iteration ${iteration + 1}`,
	});
	await stateTracker.appendLog(agent.name, `Starting iteration ${iteration}`);

	try {
		const result = await runSubprocess({
			cwd: workspace,
			agent: agentDef,
			task: agent.task,
			index,
			id: agentId,
			modelOverride,
			signal,
			onProgress: progress => {
				if (progress.lastIntent) actorOrchestrator.update(agentId, { lastIntent: progress.lastIntent });
				onProgress?.(agent.name, progress);
			},
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			artifactsDir: path.join(stateTracker.swarmDir, "context"),
		});

		actorOrchestrator.complete({ result });
		const status = result.exitCode === 0 ? ("completed" as const) : ("failed" as const);
		await stateTracker.updateAgent(agent.name, {
			status,
			completedAt: Date.now(),
			error: result.error,
		});
		await stateTracker.appendLog(
			agent.name,
			`Iteration ${iteration} ${status}${result.error ? `: ${result.error}` : ""}`,
		);
		await stateTracker.appendEvent({
			type: status === "completed" ? "agent.done" : "agent.failed",
			channel: "pipeline",
			agent: agent.name,
			iteration,
			status,
			error: result.error,
			message: `Iteration ${iteration + 1} ${status}`,
		});

		return result;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		actorOrchestrator.update(agentId, {
			status: "failed",
			completedAt: Date.now(),
			failureKind: "execution_failed",
			failureMessage: error,
		});
		await stateTracker.updateAgent(agent.name, {
			status: "failed",
			completedAt: Date.now(),
			error,
		});
		await stateTracker.appendLog(agent.name, `Iteration ${iteration} error: ${error}`);
		await stateTracker.appendEvent({
			type: "agent.failed",
			channel: "pipeline",
			agent: agent.name,
			iteration,
			status: "failed",
			error,
			message: `Iteration ${iteration + 1} error`,
		});
		throw err;
	}
}

function buildSystemPrompt(agent: SwarmAgent): string {
	const parts = [`You are a ${agent.role}.`];
	if (agent.extraContext) {
		parts.push(agent.extraContext);
	}
	return parts.join("\n\n");
}

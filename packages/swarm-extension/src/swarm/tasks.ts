/**
 * Task-board projection for DAG-owned swarm agents.
 */
import type { SwarmDefinition } from "./schema";
import type { AgentState, SwarmState } from "./state";

export interface SwarmTaskRecord {
	name: string;
	status: AgentState["status"];
	iteration: number;
	wave: number;
	role?: string;
	task?: string;
	waitsFor: string[];
	reportsTo: string[];
	startedAt?: number;
	completedAt?: number;
	error?: string;
}

export function projectSwarmTasks(state: SwarmState, def?: SwarmDefinition | null): SwarmTaskRecord[] {
	return Object.values(state.agents).map(agent => {
		const config = def?.agents.get(agent.name);
		return {
			name: agent.name,
			status: agent.status,
			iteration: agent.iteration,
			wave: agent.wave,
			role: config?.role,
			task: config?.task,
			waitsFor: config?.waitsFor ?? [],
			reportsTo: config?.reportsTo ?? [],
			startedAt: agent.startedAt,
			completedAt: agent.completedAt,
			error: agent.error,
		};
	});
}

export function renderSwarmTasks(tasks: readonly SwarmTaskRecord[]): string[] {
	if (tasks.length === 0) return ["No tasks."];
	const lines = ["Swarm tasks:"];
	for (const task of tasks) {
		const deps = task.waitsFor.length > 0 ? ` waits_for=[${task.waitsFor.join(",")}]` : "";
		const role = task.role ? ` role=${task.role}` : "";
		lines.push(`  ${task.name}: ${task.status} wave=${task.wave + 1} iteration=${task.iteration + 1}${role}${deps}`);
	}
	return lines;
}

export function renderSwarmTaskDetail(task: SwarmTaskRecord): string[] {
	const lines = [
		`Task: ${task.name}`,
		`Status: ${task.status}`,
		`Iteration: ${task.iteration + 1}`,
		`Wave: ${task.wave + 1}`,
	];
	if (task.role) lines.push(`Role: ${task.role}`);
	if (task.waitsFor.length > 0) lines.push(`Waits for: ${task.waitsFor.join(", ")}`);
	if (task.reportsTo.length > 0) lines.push(`Reports to: ${task.reportsTo.join(", ")}`);
	const duration = formatTaskDuration(task);
	if (duration) lines.push(`Duration: ${duration}`);
	if (task.task) lines.push("", "Instructions:", truncateText(task.task, 800));
	if (task.error) lines.push("", `Error: ${task.error}`);
	return lines;
}

function formatTaskDuration(task: Pick<SwarmTaskRecord, "startedAt" | "completedAt" | "status">): string | undefined {
	if (task.startedAt && task.completedAt) return formatDurationMs(task.completedAt - task.startedAt);
	if (task.startedAt && (task.status === "running" || task.status === "waiting")) {
		return `${formatDurationMs(Date.now() - task.startedAt)}...`;
	}
	return undefined;
}

function formatDurationMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function truncateText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

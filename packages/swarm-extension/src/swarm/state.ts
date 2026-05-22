/**
 * Filesystem state tracker for swarm pipeline execution.
 *
 * Persists pipeline and per-agent state to `.swarm_<name>/` in the workspace.
 * Supports resumability by loading state from disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendSwarmEvent, type NewSwarmEvent, readSwarmEvents, type SwarmEvent } from "./events";
import type { SwarmDefinition } from "./schema";

// ============================================================================
// State types
// ============================================================================

export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";

export interface AgentState {
	name: string;
	status: AgentStatus;
	iteration: number;
	wave: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
}

export interface SwarmState {
	name: string;
	status: PipelineStatus;
	mode: string;
	iteration: number;
	targetCount: number;
	agents: Record<string, AgentState>;
	startedAt: number;
	completedAt?: number;
}

interface AgentRegistryEntry extends AgentState {
	updatedAt: number;
}

// ============================================================================
// State tracker
// ============================================================================

export class StateTracker {
	#swarmDir: string;
	#state: SwarmState;

	constructor(workspaceDir: string, name: string) {
		this.#swarmDir = path.join(workspaceDir, `.swarm_${name}`);
		this.#state = {
			name,
			status: "idle",
			mode: "sequential",
			iteration: 0,
			targetCount: 1,
			agents: {},
			startedAt: Date.now(),
		};
	}

	get swarmDir(): string {
		return this.#swarmDir;
	}

	get state(): Readonly<SwarmState> {
		return this.#state;
	}

	async init(agentNames: string[], targetCount: number, mode: string): Promise<void> {
		await fs.mkdir(path.join(this.#swarmDir, "state"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "logs"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "context"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "events", "channels"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "registry"), { recursive: true });

		this.#state.targetCount = targetCount;
		this.#state.mode = mode;
		this.#state.status = "running";
		this.#state.startedAt = Date.now();

		for (const name of agentNames) {
			this.#state.agents[name] = {
				name,
				status: "pending",
				iteration: 0,
				wave: 0,
			};
		}

		await this.#persist();
		await this.#persistRegistry();
	}

	async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
		const agent = this.#state.agents[name];
		if (!agent) return;
		Object.assign(agent, update);
		await this.#persist();
		await this.#persistRegistry();
	}

	async updatePipeline(update: Partial<SwarmState>): Promise<void> {
		Object.assign(this.#state, update);
		await this.#persist();
	}

	async appendLog(agentName: string, message: string): Promise<void> {
		const logPath = path.join(this.#swarmDir, "logs", `${agentName}.log`);
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async appendOrchestratorLog(message: string): Promise<void> {
		const logPath = path.join(this.#swarmDir, "logs", "orchestrator.log");
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async appendEvent(event: Omit<NewSwarmEvent, "swarm">): Promise<SwarmEvent> {
		return appendSwarmEvent(this.#swarmDir, { ...event, swarm: this.#state.name });
	}

	async readEvents(options: { channel?: string; limit?: number } = {}): Promise<SwarmEvent[]> {
		return readSwarmEvents(this.#swarmDir, options);
	}

	async saveDefinition(def: SwarmDefinition): Promise<void> {
		const serializable = {
			name: def.name,
			workspace: def.workspace,
			mode: def.mode,
			targetCount: def.targetCount,
			model: def.model,
			agentOrder: def.agentOrder,
			agents: Object.fromEntries(def.agents),
		};
		await Bun.write(path.join(this.#swarmDir, "state", "definition.json"), JSON.stringify(serializable, null, 2));
	}

	async loadDefinition(): Promise<SwarmDefinition | null> {
		try {
			const content = await Bun.file(path.join(this.#swarmDir, "state", "definition.json")).text();
			const parsed = JSON.parse(content) as Omit<SwarmDefinition, "agents"> & {
				agents: Record<string, SwarmDefinition["agents"] extends Map<string, infer Agent> ? Agent : never>;
			};
			return {
				...parsed,
				agents: new Map(Object.entries(parsed.agents)),
			};
		} catch {
			return null;
		}
	}

	async load(): Promise<SwarmState | null> {
		const statePath = path.join(this.#swarmDir, "state", "pipeline.json");
		try {
			const content = await Bun.file(statePath).text();
			this.#state = JSON.parse(content) as SwarmState;
			return this.#state;
		} catch {
			return null;
		}
	}

	async #persist(): Promise<void> {
		await Bun.write(path.join(this.#swarmDir, "state", "pipeline.json"), JSON.stringify(this.#state, null, 2));
	}

	async #persistRegistry(): Promise<void> {
		const now = Date.now();
		const entries: Record<string, AgentRegistryEntry> = {};
		for (const [name, agent] of Object.entries(this.#state.agents)) {
			entries[name] = { ...agent, updatedAt: now };
		}
		await Bun.write(path.join(this.#swarmDir, "registry", "agents.json"), JSON.stringify(entries, null, 2));
	}
}

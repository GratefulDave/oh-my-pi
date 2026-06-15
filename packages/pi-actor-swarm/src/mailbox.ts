// ---------------------------------------------------------------------------
// Mailbox engine — disk-backed message queues with priority routing.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SwarmMessage {
	id: string;
	from: string; // sender agent ID or "user"
	to: string; // target agent ID or "*" for broadcast
	subject: string;
	body: string;
	priority: "low" | "normal" | "high" | "urgent";
	timestamp: number;
	/** Whether the message has been delivered (read by recipient). */
	delivered: boolean;
}

export type RoutingPolicy = "round-robin" | "priority" | "broadcast" | "direct";

export interface SwarmAgent {
	id: string;
	role: string;
	model: string;
	/** Agent state: idle, working, waiting, error */
	state: "idle" | "working" | "waiting" | "error";
	/** Current task description, if working. */
	currentTask: string | null;
	/** Messages this agent has sent. */
	sentCount: number;
	/** Messages this agent has received. */
	receivedCount: number;
	/** Last observed activity time used for stale-agent detection. */
	lastActivityMs: number;
	/** Whether the agent has exceeded the configured inactivity TTL. */
	stale: boolean;
}

export interface SwarmConfig {
	name: string;
	agents: SwarmAgent[];
	routingPolicy: RoutingPolicy;
	createdAt: number;
	/** Milliseconds before an inactive agent is marked stale. */
	staleAgentTtlMs: number;
}

interface SwarmState {
	config: SwarmConfig | null;
	mailboxes: Record<string, SwarmMessage[]>;
	history: SwarmMessage[];
	messageCounter: number;
}

// ---------------------------------------------------------------------------
// Disk-backed mailbox store
// ---------------------------------------------------------------------------

const DEFAULT_STALE_AGENT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PROJECT_ROOT = process.cwd();
const STATE_RELATIVE_PATH = path.join(".omp", "swarm", "state.json");
const DEFAULT_LOGS_RELATIVE_PATH = path.join(".omp", "swarm", "swarm-log.jsonl");

let projectRoot = DEFAULT_PROJECT_ROOT;
let config: SwarmConfig | null = null;
const mailboxes = new Map<string, SwarmMessage[]>();
const history: SwarmMessage[] = [];
let messageCounter = 0;
let loadedStatePath: string | null = null;

function statePath(): string {
	return path.join(projectRoot, STATE_RELATIVE_PATH);
}

function ensureStateLoaded(): void {
	const currentStatePath = statePath();
	if (loadedStatePath === currentStatePath) return;

	config = null;
	mailboxes.clear();
	history.length = 0;
	messageCounter = 0;
	loadedStatePath = currentStatePath;

	if (!existsSync(currentStatePath)) return;

	try {
		const state = JSON.parse(readFileSync(currentStatePath, "utf8")) as Partial<SwarmState>;
		config = normalizeConfig(state.config ?? null);
		messageCounter =
			typeof state.messageCounter === "number" && Number.isSafeInteger(state.messageCounter)
				? state.messageCounter
				: 0;
		if (Array.isArray(state.history)) {
			history.push(...state.history.map(normalizeMessage));
		}
		if (state.mailboxes && typeof state.mailboxes === "object") {
			for (const [agentId, queue] of Object.entries(state.mailboxes)) {
				mailboxes.set(agentId, Array.isArray(queue) ? queue.map(normalizeMessage) : []);
			}
		}
		if (config) {
			for (const agent of config.agents) {
				if (!mailboxes.has(agent.id)) mailboxes.set(agent.id, []);
			}
		}
	} catch {
		config = null;
		mailboxes.clear();
		history.length = 0;
		messageCounter = 0;
	}
}

function persistState(): void {
	ensureStateLoaded();
	const currentStatePath = statePath();
	mkdirSync(path.dirname(currentStatePath), { recursive: true });
	writeFileSync(
		currentStatePath,
		JSON.stringify(
			{
				config,
				mailboxes: Object.fromEntries(mailboxes),
				history,
				messageCounter,
			} satisfies SwarmState,
			null,
			2,
		),
	);
}

function normalizeConfig(value: Partial<SwarmConfig> | null): SwarmConfig | null {
	if (!value || !Array.isArray(value.agents)) return null;
	const createdAt =
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
	const routingPolicy = value.routingPolicy ?? "priority";
	const rawTtl = value.staleAgentTtlMs;
	const staleAgentTtlMs =
		typeof rawTtl === "number" && Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : DEFAULT_STALE_AGENT_TTL_MS;
	return {
		name: value.name ?? "default-swarm",
		agents: value.agents.map(agent => normalizeAgent(agent, createdAt, staleAgentTtlMs)),
		routingPolicy,
		createdAt,
		staleAgentTtlMs,
	};
}

function normalizeAgent(agent: Partial<SwarmAgent>, fallbackActivityMs: number, staleAgentTtlMs: number): SwarmAgent {
	const rawLastActivityMs = agent.lastActivityMs;
	const lastActivityMs =
		typeof rawLastActivityMs === "number" && Number.isFinite(rawLastActivityMs) && rawLastActivityMs > 0
			? rawLastActivityMs
			: fallbackActivityMs;
	return {
		id: agent.id ?? "agent",
		role: agent.role ?? "agent",
		model: agent.model ?? "default",
		state: agent.state ?? "idle",
		currentTask: agent.currentTask ?? null,
		sentCount: agent.sentCount ?? 0,
		receivedCount: agent.receivedCount ?? 0,
		lastActivityMs,
		stale: Date.now() - lastActivityMs > staleAgentTtlMs,
	};
}

function normalizeMessage(message: SwarmMessage): SwarmMessage {
	return {
		...message,
		delivered: Boolean(message.delivered),
	};
}

function touchAgent(agentId: string): void {
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (!agent) return;
	agent.lastActivityMs = Date.now();
	agent.stale = false;
}
function markDeliveredInHistory(message: SwarmMessage): void {
	const entry = history.find(
		item => item.id === message.id && item.to === message.to && item.subject === message.subject,
	);
	if (entry) entry.delivered = true;
}

function refreshStaleAgents(): boolean {
	if (!config) return false;
	const now = Date.now();
	let changed = false;
	for (const agent of config.agents) {
		const stale = now - agent.lastActivityMs > config.staleAgentTtlMs;
		if (agent.stale !== stale) {
			agent.stale = stale;
			changed = true;
		}
	}
	return changed;
}

export function setProjectRoot(cwd: string): void {
	const nextRoot = path.resolve(cwd);
	if (projectRoot === nextRoot) return;
	projectRoot = nextRoot;
	loadedStatePath = null;
	ensureStateLoaded();
}

export function getConfig(): SwarmConfig | null {
	ensureStateLoaded();
	if (refreshStaleAgents()) persistState();
	return config;
}
export function initSwarm(cfg: SwarmConfig): void {
	ensureStateLoaded();
	const now = Date.now();
	const normalized = normalizeConfig({
		...cfg,
		staleAgentTtlMs: cfg.staleAgentTtlMs,
		agents: cfg.agents.map(agent => ({
			...agent,
			lastActivityMs: agent.lastActivityMs || now,
			stale: false,
		})),
	});
	if (!normalized) return;
	config = normalized;
	mailboxes.clear();
	history.length = 0;
	messageCounter = 0;
	for (const agent of config.agents) {
		mailboxes.set(agent.id, []);
	}
	persistState();
}

export function clearSwarm(): void {
	ensureStateLoaded();
	config = null;
	mailboxes.clear();
	history.length = 0;
	messageCounter = 0;
	persistState();
}

/** Post a message into the swarm routing system. */
export function postMessage(msg: Omit<SwarmMessage, "id" | "timestamp" | "delivered">): SwarmMessage {
	ensureStateLoaded();
	const full: SwarmMessage = {
		...msg,
		id: `msg-${++messageCounter}`,
		timestamp: Date.now(),
		delivered: false,
	};

	if (msg.to === "*") {
		for (const [agentId, queue] of mailboxes) {
			if (agentId !== msg.from) {
				const copy = { ...full, to: agentId };
				queue.push(copy);
				history.push(copy);
				touchAgent(agentId);
			}
		}
	} else {
		const queue = mailboxes.get(msg.to);
		if (queue) {
			queue.push(full);
			history.push(full);
			touchAgent(msg.to);
		}
		if (msg.to !== msg.from) {
			const fromQueue = mailboxes.get(msg.from);
			if (fromQueue) {
				const copy = { ...full, to: msg.from, subject: `[sent] ${full.subject}` };
				fromQueue.push(copy);
				history.push(copy);
				touchAgent(msg.from);
			}
		}
	}

	persistState();
	return full;
}

/** Get the next message for an agent according to routing policy. */
export function getNextMessage(agentId: string): SwarmMessage | null {
	ensureStateLoaded();
	const queue = mailboxes.get(agentId);
	if (!queue || queue.length === 0) return null;

	const policy = config?.routingPolicy ?? "priority";
	const message = dequeueMessage(queue, policy);
	if (message) {
		markDeliveredInHistory(message);
		touchAgent(agentId);
		persistState();
	}
	return message;
}

function dequeueMessage(queue: SwarmMessage[], policy: RoutingPolicy): SwarmMessage | null {
	switch (policy) {
		case "priority": {
			const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
			let bestIdx = 0;
			for (let i = 1; i < queue.length; i++) {
				if (priorityOrder[queue[i].priority] < priorityOrder[queue[bestIdx].priority]) {
					bestIdx = i;
				}
			}
			const [msg] = queue.splice(bestIdx, 1);
			msg.delivered = true;
			return msg;
		}
		case "round-robin":
		case "broadcast":
		case "direct": {
			const msg = queue.shift();
			if (msg) msg.delivered = true;
			return msg ?? null;
		}
	}
}

/** Get all pending messages for an agent. */
export function getPendingMessages(agentId: string): SwarmMessage[] {
	ensureStateLoaded();
	return mailboxes.get(agentId) ?? [];
}

/** Get queue length for an agent. */
export function getQueueLength(agentId: string): number {
	ensureStateLoaded();
	return mailboxes.get(agentId)?.length ?? 0;
}

/** Mark all messages for an agent as delivered. */
export function deliverAll(agentId: string): number {
	ensureStateLoaded();
	const queue = mailboxes.get(agentId);
	if (!queue) return 0;
	let count = 0;
	for (const msg of queue) {
		if (!msg.delivered) {
			msg.delivered = true;
			markDeliveredInHistory(msg);
			count++;
		}
	}
	if (count > 0) {
		touchAgent(agentId);
		persistState();
	}
	return count;
}

/** Update agent state. */
export function updateAgentState(agentId: string, state: SwarmAgent["state"], currentTask?: string | null): void {
	ensureStateLoaded();
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (agent) {
		agent.state = state;
		if (currentTask !== undefined) agent.currentTask = currentTask;
		touchAgent(agentId);
		persistState();
	}
}

/** Increment agent message counts. */
export function incrementSent(agentId: string): void {
	ensureStateLoaded();
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (agent) {
		agent.sentCount++;
		touchAgent(agentId);
		persistState();
	}
}

export function incrementReceived(agentId: string): void {
	ensureStateLoaded();
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (agent) {
		agent.receivedCount++;
		touchAgent(agentId);
		persistState();
	}
}

export function exportSwarmLogs(targetPath?: string): string {
	ensureStateLoaded();
	const outputPath = targetPath
		? path.resolve(projectRoot, targetPath)
		: path.join(projectRoot, DEFAULT_LOGS_RELATIVE_PATH);
	mkdirSync(path.dirname(outputPath), { recursive: true });
	const lines: string[] = [];
	for (const message of history) {
		lines.push(JSON.stringify({ type: "message", ...message }));
	}
	if (config) {
		for (const agent of config.agents) {
			lines.push(JSON.stringify({ type: "agent", swarm: config.name, exportedAt: Date.now(), ...agent }));
		}
	}
	writeFileSync(outputPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
	return outputPath;
}

// ---------------------------------------------------------------------------
// Mailbox engine — message queues with priority routing.
// ---------------------------------------------------------------------------

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
}

export interface SwarmConfig {
	name: string;
	agents: SwarmAgent[];
	routingPolicy: RoutingPolicy;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// In-memory mailbox store
// ---------------------------------------------------------------------------

let config: SwarmConfig | null = null;
const mailboxes = new Map<string, SwarmMessage[]>();
let messageCounter = 0;

export function getConfig(): SwarmConfig | null {
	return config;
}

export function initSwarm(cfg: SwarmConfig): void {
	config = cfg;
	mailboxes.clear();
	messageCounter = 0;
	// Initialize empty mailboxes for all agents
	for (const agent of cfg.agents) {
		mailboxes.set(agent.id, []);
	}
}

export function clearSwarm(): void {
	config = null;
	mailboxes.clear();
	messageCounter = 0;
}

/** Post a message into the swarm routing system. */
export function postMessage(msg: Omit<SwarmMessage, "id" | "timestamp" | "delivered">): SwarmMessage {
	const full: SwarmMessage = {
		...msg,
		id: `msg-${++messageCounter}`,
		timestamp: Date.now(),
		delivered: false,
	};

	if (msg.to === "*") {
		// Broadcast: deliver to all agents
		for (const [agentId, queue] of mailboxes) {
			if (agentId !== msg.from) {
				queue.push({ ...full, to: agentId });
			}
		}
	} else {
		const queue = mailboxes.get(msg.to);
		if (queue) {
			queue.push(full);
		}
		// Also deliver a copy back to sender's mailbox (self-cc)
		if (msg.to !== msg.from) {
			const fromQueue = mailboxes.get(msg.from);
			if (fromQueue) {
				fromQueue.push({ ...full, to: msg.from, subject: `[sent] ${full.subject}` });
			}
		}
	}

	return full;
}

/** Get the next message for an agent according to routing policy. */
export function getNextMessage(agentId: string): SwarmMessage | null {
	const queue = mailboxes.get(agentId);
	if (!queue || queue.length === 0) return null;

	const policy = config?.routingPolicy ?? "priority";
	return dequeueMessage(queue, policy);
}

function dequeueMessage(queue: SwarmMessage[], policy: RoutingPolicy): SwarmMessage | null {
	switch (policy) {
		case "priority": {
			// Dequeue highest priority first (urgent > high > normal > low)
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
		case "round-robin": {
			// FIFO
			const msg = queue.shift();
			if (msg) msg.delivered = true;
			return msg ?? null;
		}
		case "broadcast":
		case "direct": {
			// FIFO by default
			const msg = queue.shift();
			if (msg) msg.delivered = true;
			return msg ?? null;
		}
		default: {
			const msg = queue.shift();
			if (msg) msg.delivered = true;
			return msg ?? null;
		}
	}
}

/** Get all pending messages for an agent. */
export function getPendingMessages(agentId: string): SwarmMessage[] {
	return mailboxes.get(agentId) ?? [];
}

/** Get queue length for an agent. */
export function getQueueLength(agentId: string): number {
	return mailboxes.get(agentId)?.length ?? 0;
}

/** Mark all messages for an agent as delivered. */
export function deliverAll(agentId: string): number {
	const queue = mailboxes.get(agentId);
	if (!queue) return 0;
	let count = 0;
	for (const msg of queue) {
		if (!msg.delivered) {
			msg.delivered = true;
			count++;
		}
	}
	return count;
}

/** Update agent state. */
export function updateAgentState(agentId: string, state: SwarmAgent["state"], currentTask?: string | null): void {
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (agent) {
		agent.state = state;
		if (currentTask !== undefined) agent.currentTask = currentTask;
	}
}

/** Increment agent message counts. */
export function incrementSent(agentId: string): void {
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (agent) agent.sentCount++;
}

export function incrementReceived(agentId: string): void {
	if (!config) return;
	const agent = config.agents.find(a => a.id === agentId);
	if (agent) agent.receivedCount++;
}

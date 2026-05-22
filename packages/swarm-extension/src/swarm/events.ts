/**
 * Append-only swarm event feed.
 *
 * Events are stored under `.swarm_<name>/events/` so the DAG scheduler remains
 * the source of truth while mesh-style coordination gets a durable transcript.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SwarmEventType =
	| "pipeline.start"
	| "pipeline.iteration"
	| "wave.start"
	| "agent.waiting"
	| "agent.start"
	| "agent.progress"
	| "agent.done"
	| "agent.failed"
	| "message"
	| "reservation.claim"
	| "reservation.release";

export interface SwarmEvent {
	id: string;
	timestamp: string;
	type: SwarmEventType;
	swarm: string;
	channel?: string;
	agent?: string;
	iteration?: number;
	wave?: number;
	from?: string;
	to?: string;
	resource?: string;
	reason?: string;
	message?: string;
	status?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

export type NewSwarmEvent = Omit<SwarmEvent, "id" | "timestamp"> & {
	id?: string;
	timestamp?: string;
};

export interface ReadEventsOptions {
	channel?: string;
	limit?: number;
}

const CHANNEL_RE = /^[a-zA-Z0-9._-]+$/;

export async function appendSwarmEvent(swarmDir: string, event: NewSwarmEvent): Promise<SwarmEvent> {
	const record: SwarmEvent = {
		...event,
		id: event.id ?? randomUUID(),
		timestamp: event.timestamp ?? new Date().toISOString(),
	};
	const line = `${JSON.stringify(record)}\n`;
	const eventsDir = path.join(swarmDir, "events");
	await fs.mkdir(eventsDir, { recursive: true });
	await fs.appendFile(path.join(eventsDir, "feed.jsonl"), line);
	if (record.channel) {
		const channelName = sanitizeChannelName(record.channel);
		const channelDir = path.join(eventsDir, "channels");
		await fs.mkdir(channelDir, { recursive: true });
		await fs.appendFile(path.join(channelDir, `${channelName}.jsonl`), line);
	}
	return record;
}

export async function readSwarmEvents(swarmDir: string, options: ReadEventsOptions = {}): Promise<SwarmEvent[]> {
	const eventPath = options.channel
		? path.join(swarmDir, "events", "channels", `${sanitizeChannelName(options.channel)}.jsonl`)
		: path.join(swarmDir, "events", "feed.jsonl");
	let content: string;
	try {
		content = await Bun.file(eventPath).text();
	} catch {
		return [];
	}
	const events: SwarmEvent[] = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		try {
			events.push(JSON.parse(line) as SwarmEvent);
		} catch {
			// Preserve the rest of the feed if one line is corrupt or partially written.
		}
	}
	if (options.limit !== undefined && options.limit >= 0 && events.length > options.limit) {
		return events.slice(events.length - options.limit);
	}
	return events;
}

export function renderSwarmEvents(events: readonly SwarmEvent[]): string[] {
	if (events.length === 0) return ["No events."];
	return events.map(formatSwarmEventLine);
}

function formatSwarmEventLine(event: SwarmEvent): string {
	const time = event.timestamp.replace(/^.*T/, "").replace(/\.\d+Z$/, "Z");
	const actor = event.agent ?? event.from ?? event.to ?? event.resource ?? "swarm";
	const detail = event.message ?? event.error ?? event.reason ?? event.status;
	return detail ? `[${time}] ${event.type} ${actor}: ${detail}` : `[${time}] ${event.type} ${actor}`;
}

function sanitizeChannelName(channel: string): string {
	if (!CHANNEL_RE.test(channel)) {
		throw new Error("channel may only contain letters, numbers, dot, underscore, and dash");
	}
	return channel;
}

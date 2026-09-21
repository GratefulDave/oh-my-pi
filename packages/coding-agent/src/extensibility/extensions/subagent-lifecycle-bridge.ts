/**
 * Forward session-tree `task:subagent:lifecycle` frames to parent extensions.
 *
 * Child sessions get a private `eventBus`. Lifecycle frames land on that bus
 * plus the inherited observability bus (`subagentEventBus`). The parent
 * Herdr reporter listens on `pi.on("subagent_lifecycle")` / `pi.events`
 * (the parent's session bus) — so without this bridge, `activeSubagents`
 * stays empty and a settled parent paints idle while descendants run.
 */
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "../../task/types";
import type { EventBus } from "../../utils/event-bus";
import type { ExtensionRunner } from "./runner";
import type { SubagentLifecycleEvent } from "./types";

const LIFECYCLE_STATUSES: Record<SubagentLifecyclePayload["status"], true> = {
	started: true,
	completed: true,
	failed: true,
	aborted: true,
};

function asLifecyclePayload(data: unknown): SubagentLifecyclePayload | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) return undefined;
	if (typeof record.status !== "string" || !LIFECYCLE_STATUSES[record.status as SubagentLifecyclePayload["status"]]) {
		return undefined;
	}
	return data as SubagentLifecyclePayload;
}

/**
 * Subscribe `buses` for subagent lifecycle and emit `subagent_lifecycle` on
 * `runner` in publication order. Dual-published frames share one object
 * reference (see `emitSubagentFrame`); the WeakSet drops the alias.
 *
 * Returns an unbind that also drops queued emits still in the FIFO chain.
 */
export function bindSubagentLifecycle(runner: ExtensionRunner, buses: readonly EventBus[]): () => void {
	let active = true;
	let chain = Promise.resolve();
	const seen = new WeakSet<object>();
	const unsubscribers: Array<() => void> = [];
	const uniqueBuses: EventBus[] = [];
	for (const bus of buses) {
		if (!uniqueBuses.includes(bus)) uniqueBuses.push(bus);
	}

	const forward = (data: unknown): void => {
		if (!active) return;
		if (data !== null && typeof data === "object") {
			if (seen.has(data)) return;
			seen.add(data);
		}
		const payload = asLifecyclePayload(data);
		if (!payload) return;
		const event: SubagentLifecycleEvent = { type: "subagent_lifecycle", ...payload };
		chain = chain
			.then(() => {
				if (!active) return;
				return runner.emit(event);
			})
			.then(
				() => undefined,
				() => undefined,
			);
	};

	for (const bus of uniqueBuses) {
		unsubscribers.push(bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, forward));
	}

	return () => {
		active = false;
		for (const unsub of unsubscribers) unsub();
		unsubscribers.length = 0;
	};
}

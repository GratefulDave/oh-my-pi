/**
 * Parent Herdr reporters subscribe to `subagent_lifecycle`. Child sessions
 * publish `task:subagent:lifecycle` on a private eventBus plus the inherited
 * observability bus — not the parent's session bus — so without the bridge
 * a settled parent paints idle while descendants run.
 *
 * The aggregator below is the stock herdr-omp v9 contract:
 * working := main working OR any subagent working.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { bindSubagentLifecycle } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/subagent-lifecycle-bridge";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
let modelRegistry: ModelRegistry;

beforeAll(() => {
	modelRegistry = new ModelRegistry(sharedAuthStorage);
});

afterAll(() => {
	sharedAuthStorage.close();
});

function lifecycle(id: string, status: SubagentLifecyclePayload["status"], index = 0): SubagentLifecyclePayload {
	return { id, agent: "scout", agentSource: "bundled", status, index };
}

async function waitFor<T>(read: () => T, expected: T): Promise<T> {
	const deadline = Date.now() + 1000;
	while (!Object.is(read(), expected)) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${String(expected)}; last ${String(read())}`);
		}
		await Promise.resolve();
	}
	return read();
}

async function createBridgedRunner(
	register: (pi: ExtensionAPI) => void,
	buses: EventBus[],
): Promise<{ runner: ExtensionRunner; unbind: () => void }> {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(register, "/tmp", new EventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, "/tmp", SessionManager.inMemory(), modelRegistry);
	return { runner, unbind: bindSubagentLifecycle(runner, buses) };
}

describe("bindSubagentLifecycle", () => {
	it("forwards observability-bus frames the parent session bus never sees", async () => {
		const sessionBus = new EventBus();
		const observabilityBus = new EventBus();
		const statuses: string[] = [];
		const { unbind } = await createBridgedRunner(
			pi => {
				pi.on("subagent_lifecycle", event => {
					statuses.push(event.status);
				});
			},
			[sessionBus, observabilityBus],
		);

		const frame = lifecycle("ScoutA", "started");
		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame);
		await waitFor(() => statuses.join(","), "started");
		expect(statuses).toEqual(["started"]);
		unbind();
	});

	it("dedupes the same payload published on both buses", async () => {
		const sessionBus = new EventBus();
		const observabilityBus = new EventBus();
		const statuses: string[] = [];
		const { unbind } = await createBridgedRunner(
			pi => {
				pi.on("subagent_lifecycle", event => {
					statuses.push(`${event.id}:${event.status}`);
				});
			},
			[sessionBus, observabilityBus],
		);

		const frame = lifecycle("ScoutA", "started");
		sessionBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame);
		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame);
		await waitFor(() => statuses.length, 1);
		await Promise.resolve();
		expect(statuses).toEqual(["ScoutA:started"]);
		unbind();
	});

	it("preserves start-then-settle order and drops frames after unbind", async () => {
		const observabilityBus = new EventBus();
		const statuses: string[] = [];
		const { unbind } = await createBridgedRunner(
			pi => {
				pi.on("subagent_lifecycle", event => {
					statuses.push(event.status);
				});
			},
			[observabilityBus],
		);

		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "started"));
		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "completed"));
		await waitFor(() => statuses.join(","), "started,completed");

		unbind();
		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutB", "started"));
		await Promise.resolve();
		await Promise.resolve();
		expect(statuses).toEqual(["started", "completed"]);
	});

	it("ignores frames without an id or known status", async () => {
		const observabilityBus = new EventBus();
		const statuses: string[] = [];
		const { unbind } = await createBridgedRunner(
			pi => {
				pi.on("subagent_lifecycle", event => {
					statuses.push(event.status);
				});
			},
			[observabilityBus],
		);

		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { status: "started" });
		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "ScoutA", status: "running" });
		observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "failed"));
		await waitFor(() => statuses.join(","), "failed");
		expect(statuses).toEqual(["failed"]);
		unbind();
	});
});

describe("Herdr pane aggregation contract", () => {
	async function createAggregator(): Promise<{
		state: () => "working" | "idle";
		sessionBus: EventBus;
		observabilityBus: EventBus;
		unbind: () => void;
		emitAgentStart: () => Promise<void>;
		emitAgentEnd: (willContinue?: boolean) => Promise<void>;
	}> {
		const sessionBus = new EventBus();
		const observabilityBus = new EventBus();
		let agentActive = false;
		const activeSubagents = new Set<string>();
		let state: "working" | "idle" = "idle";
		const publish = (): void => {
			state = agentActive || activeSubagents.size > 0 ? "working" : "idle";
		};

		const { runner, unbind } = await createBridgedRunner(
			pi => {
				pi.on("agent_start", () => {
					agentActive = true;
					publish();
				});
				pi.on("agent_end", event => {
					if (event.willContinue === true) return;
					agentActive = false;
					publish();
				});
				pi.on("subagent_lifecycle", event => {
					if (event.status === "started") activeSubagents.add(event.id);
					else activeSubagents.delete(event.id);
					publish();
				});
			},
			[sessionBus, observabilityBus],
		);

		return {
			state: () => state,
			sessionBus,
			observabilityBus,
			unbind,
			emitAgentStart: async () => {
				await runner.emit({ type: "agent_start" });
			},
			emitAgentEnd: async (willContinue?: boolean) => {
				await runner.emit({ type: "agent_end", messages: [], willContinue });
			},
		};
	}

	it("main working, no subagents → working", async () => {
		const agg = await createAggregator();
		await agg.emitAgentStart();
		expect(agg.state()).toBe("working");
		agg.unbind();
	});

	it("main idle and a subagent working → working", async () => {
		const agg = await createAggregator();
		await agg.emitAgentStart();
		agg.observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "started"));
		await waitFor(agg.state, "working");
		await agg.emitAgentEnd();
		expect(agg.state()).toBe("working");
		agg.unbind();
	});

	it("main working and a subagent working → working", async () => {
		const agg = await createAggregator();
		await agg.emitAgentStart();
		agg.observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "started"));
		await waitFor(agg.state, "working");
		expect(agg.state()).toBe("working");
		agg.unbind();
	});

	it("all idle → idle", async () => {
		const agg = await createAggregator();
		await agg.emitAgentStart();
		agg.observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "started"));
		await waitFor(agg.state, "working");
		await agg.emitAgentEnd();
		agg.observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "completed"));
		await waitFor(agg.state, "idle");
		agg.unbind();
	});

	it("promotes a settled parent when a descendant starts later", async () => {
		const agg = await createAggregator();
		await agg.emitAgentStart();
		await agg.emitAgentEnd();
		expect(agg.state()).toBe("idle");
		agg.observabilityBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ScoutA", "started"));
		await waitFor(agg.state, "working");
		agg.unbind();
	});
});

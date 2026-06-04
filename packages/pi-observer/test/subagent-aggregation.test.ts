// ---------------------------------------------------------------------------
// Proves the parent observer rolls up subagent activity that arrives on the
// shared EventBus (TASK_SUBAGENT_PROGRESS_CHANNEL / *_LIFECYCLE_CHANNEL).
//
// Regression target: subagents run in a separate AgentSession, so their own
// pi.on(...) tool/token events never reach the parent observer extension. The
// only path is the parent EventBus fan-in channels — this test exercises that
// full wiring through the extension's default export.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from "bun:test";
import observer from "../src/extension";
import {
	getStats,
	getSubagentTotals,
	onSubagentLifecycle,
	onSubagentProgress,
	resetStats,
} from "../src/stats-collector";

const PROGRESS_CHANNEL = "task:subagent:progress";
const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Minimal EventBus matching coding-agent's on/emit contract. */
class FakeEventBus {
	#listeners = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) this.#listeners.set(channel, new Set());
		this.#listeners.get(channel)!.add(handler);
		return () => this.#listeners.get(channel)?.delete(handler);
	}
	emit(channel: string, data: unknown): void {
		for (const h of this.#listeners.get(channel) ?? []) h(data);
	}
}

/** Minimal ExtensionAPI stub exposing just what observer() touches. */
function makeFakePi() {
	const events = new FakeEventBus();
	const pi = {
		events,
		setLabel() {},
		on() {},
		registerCommand() {},
	};
	return { pi: pi as Parameters<typeof observer>[0], events };
}

describe("pi-observer subagent fan-in", () => {
	beforeEach(() => {
		resetStats();
	});

	test("getSubagentTotals starts empty", () => {
		const totals = getSubagentTotals();
		expect(totals).toEqual({ count: 0, activeCount: 0, tokens: 0, toolCount: 0, cost: 0 });
		expect(getStats().subagents.size).toBe(0);
	});

	test("progress event updates cumulative totals (overwrite, not add)", () => {
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 100, toolCount: 2, cost: 0.01 });
		expect(getSubagentTotals()).toEqual({ count: 1, activeCount: 1, tokens: 100, toolCount: 2, cost: 0.01 });

		// Second snapshot is cumulative for the same id -> overwrite, not add.
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 250, toolCount: 5, cost: 0.03 });
		expect(getSubagentTotals()).toEqual({ count: 1, activeCount: 1, tokens: 250, toolCount: 5, cost: 0.03 });
	});

	test("multiple subagents sum; lifecycle flips active count", () => {
		onSubagentProgress({ id: "a1", agent: "explore", status: "running", tokens: 100, toolCount: 2, cost: 0.01 });
		onSubagentProgress({ id: "a2", agent: "executor", status: "running", tokens: 300, toolCount: 4, cost: 0.05 });
		const summed = getSubagentTotals();
		expect(summed.count).toBe(2);
		expect(summed.activeCount).toBe(2);
		expect(summed.tokens).toBe(400);
		expect(summed.toolCount).toBe(6);
		expect(summed.cost).toBeCloseTo(0.06, 6);

		onSubagentLifecycle("a1", "explore", "completed");
		const totals = getSubagentTotals();
		expect(totals.count).toBe(2);
		expect(totals.activeCount).toBe(1);
		expect(totals.tokens).toBe(400);
	});

	test("end-to-end: parent observer reflects a subagent event via the shared EventBus", () => {
		const { pi, events } = makeFakePi();
		observer(pi);

		// Subagent emits aggregated progress on the PARENT bus (as the task executor does).
		events.emit(PROGRESS_CHANNEL, {
			index: 0,
			agent: "explore",
			task: "trace bug",
			progress: { id: "sub-1", agent: "explore", status: "running", tokens: 1234, toolCount: 7, cost: 0.12 },
		});

		const totals = getSubagentTotals();
		expect(totals.count).toBe(1);
		expect(totals.tokens).toBe(1234);
		expect(totals.toolCount).toBe(7);
		expect(totals.cost).toBeCloseTo(0.12, 6);

		// Lifecycle "completed" marks it inactive but keeps its accumulated totals.
		events.emit(LIFECYCLE_CHANNEL, { id: "sub-1", agent: "explore", status: "completed", index: 0 });
		const after = getSubagentTotals();
		expect(after.activeCount).toBe(0);
		expect(after.tokens).toBe(1234);
	});

	test("malformed payloads are ignored", () => {
		const { pi, events } = makeFakePi();
		observer(pi);
		events.emit(PROGRESS_CHANNEL, undefined);
		events.emit(PROGRESS_CHANNEL, { progress: null });
		events.emit(PROGRESS_CHANNEL, { progress: { agent: "x" } }); // no id
		events.emit(LIFECYCLE_CHANNEL, { status: "completed" }); // no id
		expect(getSubagentTotals().count).toBe(0);
	});
});

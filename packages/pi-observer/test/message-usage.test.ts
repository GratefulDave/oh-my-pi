import { describe, expect, test } from "bun:test";
import observer from "../src/extension";
import { getStats, resetStats } from "../src/stats-collector";

type EventHandler = (event: unknown, ctx: unknown) => void;

describe("observer token accounting", () => {
	test("records usage from the persisted assistant message", () => {
		resetStats();
		const handlers = new Map<string, EventHandler>();
		const pi = {
			events: { on() {} },
			setLabel() {},
			on(event: string, handler: EventHandler) {
				handlers.set(event, handler);
			},
			registerCommand() {},
		} as Parameters<typeof observer>[0];
		observer(pi);

		const messageEnd = handlers.get("message_end");
		expect(messageEnd).toBeDefined();
		messageEnd?.(
			{
				message: {
					role: "assistant",
					model: "openai-codex/gpt-5.6-terra",
					usage: { input: 1_200, output: 350 },
				},
			},
			{ model: { id: "fallback/model" } },
		);

		const stats = getStats();
		expect(stats.totalTokensInput).toBe(1_200);
		expect(stats.totalTokensOutput).toBe(350);
	});
});

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream";

function createPartial(text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("AssistantMessageEventStream", () => {
	it("coalesces adjacent text deltas for slow consumers", () => {
		const stream = new AssistantMessageEventStream();

		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: createPartial("a") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial: createPartial("ab") });

		expect(stream.queue).toHaveLength(1);
		const event = stream.queue[0];
		expect(event).toMatchObject({ type: "text_delta", contentIndex: 0, delta: "ab" });
		expect(event?.type).toBe("text_delta");
		if (event?.type !== "text_delta") throw new Error("Expected text delta");
		expect(event.partial.content).toEqual([{ type: "text", text: "ab" }]);
	});

	it("does not coalesce deltas from different content blocks", () => {
		const stream = new AssistantMessageEventStream();

		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: createPartial("a") });
		stream.push({ type: "text_delta", contentIndex: 1, delta: "b", partial: createPartial("ab") });

		expect(stream.queue).toHaveLength(2);
	});
});

describe("EventStream", () => {
	it("fails instead of growing beyond a bounded queue", async () => {
		const stream = new EventStream<number, number>(
			event => event === 99,
			event => event,
			{ maxQueueSize: 1 },
		);

		stream.push(1);
		stream.push(2);

		expect(stream.queue).toEqual([1]);
		let error: unknown;
		try {
			await stream.result();
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("EventStream queue exceeded 1 queued events");
	});

	it("queues terminal events even when the bounded queue is full", async () => {
		const stream = new EventStream<number, string>(
			event => event === 99,
			() => "done",
			{ maxQueueSize: 1 },
		);

		stream.push(1);
		stream.push(99);

		expect(stream.queue).toEqual([1, 99]);
		expect(await stream.result()).toBe("done");
	});
});

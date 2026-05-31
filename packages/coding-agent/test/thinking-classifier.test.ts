import { describe, expect, it, spyOn } from "bun:test";
import type { Model } from "../../ai/src";
import * as ai from "../../ai/src";
import type { ModelRegistry } from "../src/config/model-registry";
import { ONLINE_TINY_TITLE_MODEL_KEY } from "../src/tiny/models";
import { classifyUserTurn } from "../src/utils/thinking-classifier";

describe("classifyUserTurn", () => {
	it("classifies user turns online correctly using smol model", async () => {
		const mockModel: Model = {
			id: "claude-haiku",
			provider: "anthropic",
			api: "anthropic-messages",
			name: "Claude Haiku",
			contextWindow: 200000,
			maxOutputTokens: 4000,
		} as any;

		const mockRegistry = {
			getAvailable: () => [mockModel],
			getApiKey: async () => "mock-api-key",
			authStorage: {} as any,
		} as any as ModelRegistry;

		// Mock classification completion response
		const responseText = "  low  \n";

		const spy = spyOn(ai, "completeSimple").mockImplementation(
			async () =>
				({
					content: [{ type: "text", text: responseText }],
				}) as any,
		);

		try {
			const result = await classifyUserTurn(
				"Help me write a simple function to add two numbers.",
				ONLINE_TINY_TITLE_MODEL_KEY,
				mockRegistry,
				"session-1",
				"high" as any,
			);

			expect(result as any).toBe("low");
		} finally {
			spy.mockRestore();
		}
	});

	it("falls back to default on error or timeout", async () => {
		const mockRegistry = {
			getAvailable: () => [],
			getApiKey: async () => null,
		} as any as ModelRegistry;

		const result = await classifyUserTurn(
			"any message",
			ONLINE_TINY_TITLE_MODEL_KEY,
			mockRegistry,
			"session-1",
			"medium" as any,
		);

		expect(result as any).toBe("medium");
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { omlxModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

async function discoverOmlxModels(modelsPayload: unknown, statusPayload: unknown = { models: [] }) {
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(init?.method).toBe("GET");
		if (url === "http://127.0.0.1:18790/v1/models/status") {
			return new Response(JSON.stringify(statusPayload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "http://127.0.0.1:18790/v1/models") {
			return new Response(JSON.stringify(modelsPayload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected URL: ${url}`);
	});
	global.fetch = fetchMock as unknown as typeof fetch;

	const options = omlxModelManagerOptions();
	expect(options.fetchDynamicModels).toBeDefined();
	const models = await options.fetchDynamicModels?.();
	expect(models).not.toBeNull();
	return { models: models ?? [], fetchMock };
}

describe("OMLX model limits mapping", () => {
	it("uses model limits returned by OMLX /models/status", async () => {
		const { models, fetchMock } = await discoverOmlxModels(
			{
				data: [{ id: "Local-Model-32B-MLX" }],
			},
			{
				models: [
					{
						id: "Local-Model-32B-MLX",
						max_context_window: 196_608,
						max_tokens: 24_576,
					},
				],
			},
		);

		const model = models.find(candidate => candidate.id === "Local-Model-32B-MLX");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(196_608);
		expect(model?.maxTokens).toBe(24_576);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("uses max_model_len when context_window is absent", async () => {
		const { models } = await discoverOmlxModels({
			data: [
				{
					id: "Another-Local-Model-MLX",
					max_model_len: 131_072,
					max_completion_tokens: 16_384,
				},
			],
		});

		const model = models.find(candidate => candidate.id === "Another-Local-Model-MLX");
		expect(model?.contextWindow).toBe(131_072);
		expect(model?.maxTokens).toBe(16_384);
	});
});

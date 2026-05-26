import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../../src/session/agent-storage";
import { searchCodex } from "../../src/web/search/providers/codex";
import { searchGemini } from "../../src/web/search/providers/gemini";
import { searchPerplexity } from "../../src/web/search/providers/perplexity";
import { SearchProviderError } from "../../src/web/search/types";

function makeErrorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mockAgentStorage(listAuthCredentials: (provider: string) => Array<{ id: number; credential: unknown }>): void {
	vi.spyOn(AgentStorage, "open").mockResolvedValue({ listAuthCredentials } as unknown as AgentStorage);
}

describe("web search provider HTTP error classification", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PERPLEXITY_API_KEY;
	});

	it("classifies Codex auth failures", async () => {
		mockAgentStorage(provider =>
			provider === "openai-codex"
				? [
						{
							id: 1,
							credential: {
								type: "oauth",
								access: "codex-token",
								expires: Date.now() + 600_000,
								accountId: "acct-1",
							},
						},
					]
				: [],
		);

		using _hook = hookFetch(() => makeErrorResponse(401, "invalid api key"));

		const error = (await searchCodex({ query: "bad auth" }).catch(value => value)) as SearchProviderError;
		expect(error).toBeInstanceOf(SearchProviderError);
		expect(error.provider).toBe("codex");
		expect(error.status).toBe(401);
		expect(error.message).toContain("Codex authorization failed (401): invalid api key");
	});

	it("classifies Gemini auth failures", async () => {
		mockAgentStorage(provider =>
			provider === "google-gemini-cli"
				? [
						{
							id: 2,
							credential: {
								type: "oauth",
								access: "gemini-token",
								expires: Date.now() + 600_000,
								projectId: "proj-1",
							},
						},
					]
				: [],
		);

		using _hook = hookFetch(() => makeErrorResponse(401, "invalid credentials"));

		const error = (await searchGemini({ query: "bad auth" }).catch(value => value)) as SearchProviderError;
		expect(error).toBeInstanceOf(SearchProviderError);
		expect(error.provider).toBe("gemini");
		expect(error.status).toBe(401);
		expect(error.message).toContain("Gemini authorization failed (401): invalid credentials");
	});

	it("classifies Perplexity quota failures", async () => {
		process.env.PERPLEXITY_API_KEY = "test-perplexity-key";

		using _hook = hookFetch(() => makeErrorResponse(402, "insufficient credits"));

		const error = (await searchPerplexity({ query: "quota" }).catch(value => value)) as SearchProviderError;
		expect(error).toBeInstanceOf(SearchProviderError);
		expect(error.provider).toBe("perplexity");
		expect(error.status).toBe(402);
		expect(error.message).toContain("Perplexity quota exhausted (402): insufficient credits");
	});
});

import { describe, expect, test } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { refreshAntigravityCredentials, serializeAntigravityCredentials } from "../src/runtime/credentials";
import { fetchAntigravityModels } from "../src/runtime/quota";
import { bridgeFetch } from "../src/stream-adapter";

describe("Antigravity live endpoints", () => {
	test.skipIf(process.env.ANTIGRAVITY_LIVE_ENDPOINTS !== "1")(
		"uses live Cloud Code model and content endpoints",
		async () => {
			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				const row = store.listAuthCredentials("antigravity").find(entry => entry.credential.type === "oauth");
				const credential = row?.credential;
				if (credential?.type !== "oauth") {
					throw new Error("Run omp login antigravity first.");
				}

				const refreshed = await refreshAntigravityCredentials(credential);
				const serialized = serializeAntigravityCredentials(refreshed);
				const models = await fetchAntigravityModels(serialized);
				expect(models.some(model => model.provider === "antigravity" && model.api === "antigravity-google")).toBe(
					true,
				);
				expect(models.some(model => model.id === "claude-sonnet-4-6")).toBe(true);
				expect(models.some(model => model.id === "gemini-pro-agent")).toBe(true);

				async function callModel(modelId: string): Promise<Response> {
					return bridgeFetch(
						`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse`,
						{
							method: "POST",
							headers: { "x-goog-api-key": "stale-key" },
							body: JSON.stringify({
								contents: [{ role: "user", parts: [{ text: "hello" }] }],
								generationConfig: { maxOutputTokens: 8 },
							}),
						},
						refreshed,
					);
				}

				let response = await callModel("claude-sonnet-4-6");
				if (response.status === 429) response = await callModel("gemini-3.5-flash-low");
				expect(response.status).toBe(200);
				const text = await response.text();
				expect(text).toContain("data:");
				expect(text).not.toContain('"error"');
			} finally {
				store.close();
			}
		},
	);
});

import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "edit app.py", timestamp: Date.now() }],
		tools: [
			{
				name: "edit",
				description: "Edit a file",
				parameters: {
					type: "object",
					properties: {
						i: { type: "string" },
						input: { type: "string" },
					},
					required: ["input"],
				},
			},
		],
	};
}

function chunk(model: Model<"openai-completions">, delta: Record<string, unknown>, finish_reason?: string): unknown {
	return {
		id: "chatcmpl-mtplx-tool-echo",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }],
	};
}

describe("MTPLX OpenAI-compatible tool-call echoes", () => {
	it("drops visible text that only mirrors a structured tool call", async () => {
		const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");
		const editInput = `[app.py#1D44]\nSWAP 105.=143:\n+    def _compose_dashboard(self, vm: ReportViewModel) -> ComposeResult:\n+        if Static is not None:\n+            yield Static(f"Scan complete: {self._paths_seen:,} paths visited", id="scan_status")\n+            yield Static(self._summary_text(vm), id="summary")`;
		const fetchMock = createMockFetch([
			chunk(model, {
				content: `\n\n\nEdit app.py\n\n\n${editInput}\n\n`,
				tool_calls: [
					{
						index: 0,
						id: "call_echo",
						type: "function",
						function: { name: "edit", arguments: JSON.stringify({ i: "Edit app.py", input: editInput }) },
					},
				],
			}),
			chunk(model, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_echo", name: "edit", arguments: { i: "Edit app.py", input: editInput } },
		]);
	});

	it("keeps real explanatory text before a structured tool call", async () => {
		const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");
		const fetchMock = createMockFetch([
			chunk(model, { content: "I'll update the dashboard now. " }),
			chunk(model, {
				tool_calls: [
					{
						index: 0,
						id: "call_real_text",
						type: "function",
						function: { name: "edit", arguments: JSON.stringify({ i: "Edit app.py", input: "short patch" }) },
					},
				],
			}),
			chunk(model, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{ type: "text", text: "I'll update the dashboard now. " },
			{
				type: "toolCall",
				id: "call_real_text",
				name: "edit",
				arguments: { i: "Edit app.py", input: "short patch" },
			},
		]);
	});
});

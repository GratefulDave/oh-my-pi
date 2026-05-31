import { completeSimple, type Effort } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { tinyTitleClient } from "../tiny/title-client";

const CLASSIFICATION_SYSTEM_PROMPT = `Classify the user's coding/development message into one of these five complexity levels based on how much reasoning, planning, and depth it requires:
- "minimal": simple greetings, chit-chat, trivial single-line changes, basic questions, or status checks.
- "low": basic single-file code changes, explaining a small function, simple edits, or simple unit test additions.
- "medium": typical coding tasks, editing multiple files, moderate debugging, or multi-step local tasks.
- "high": complex multi-file refactoring, writing algorithms, debugging hard errors, or heavy logical changes.
- "xhigh": extremely complex codebase architecture, hard debugging spanning multiple packages, or highly critical, delicate logic.

Reply with exactly one word from this list: minimal, low, medium, high, xhigh. Do not include any other text, quotes, formatting, or explanation.`;

export async function classifyUserTurn(
	messageText: string,
	classifierModelKey: string,
	registry: ModelRegistry,
	sessionId: string | undefined,
	fallback: Effort,
	signal?: AbortSignal,
): Promise<Effort> {
	const text = messageText.trim();
	if (!text) return fallback;

	logger.debug("thinking-classifier: classifying turn", { model: classifierModelKey, text: text.slice(0, 100) });

	try {
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), 4000);
		if (signal) {
			signal.addEventListener("abort", () => timeoutController.abort());
		}

		let resultText: string | null = null;

		if (classifierModelKey === ONLINE_TINY_TITLE_MODEL_KEY) {
			const smolModel =
				registry
					.getAvailable()
					.find((m: any) => m.id.includes("haiku") || m.id.includes("flash") || m.id.includes("mini")) ??
				registry.getAvailable().find((m: any) => m.provider === "openai" || m.provider === "anthropic") ??
				registry.getAvailable()[0];

			if (smolModel) {
				const apiKey = await registry.getApiKey(smolModel, sessionId);
				if (apiKey) {
					const response = await completeSimple(
						smolModel,
						{
							systemPrompt: [CLASSIFICATION_SYSTEM_PROMPT],
							messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
						},
						{
							apiKey,
							maxTokens: 10,
							disableReasoning: true,
							signal: timeoutController.signal,
						},
					);
					resultText = response.content
						.map(b => (b.type === "text" ? b.text : ""))
						.join("")
						.trim();
				}
			}
		} else {
			resultText = await tinyTitleClient.complete(
				classifierModelKey,
				`${CLASSIFICATION_SYSTEM_PROMPT}\n\nUser message:\n${text}\n\nClassification:`,
				{
					maxTokens: 5,
					signal: timeoutController.signal,
				},
			);
		}

		clearTimeout(timeoutId);

		if (resultText) {
			const clean = resultText
				.toLowerCase()
				.replace(/[^a-z]/g, "")
				.trim();
			if (["minimal", "low", "medium", "high", "xhigh"].includes(clean)) {
				logger.debug("thinking-classifier: classification result", { result: clean });
				return clean as Effort;
			}
		}
	} catch (error) {
		logger.debug("thinking-classifier: classification failed or timed out, using fallback", {
			error: error instanceof Error ? error.message : String(error),
			fallback,
		});
	}

	return fallback;
}

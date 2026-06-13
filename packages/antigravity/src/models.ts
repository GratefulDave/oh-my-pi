import { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_API = "antigravity-google";
export const GOOGLE_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT = 1_000_000;
const DEFAULT_MAX_TOKENS = 65_536;

function model(
	id: string,
	name: string,
	reasoning: boolean,
	input: ProviderModelConfig["input"],
	contextWindow: number,
	thinking?: ProviderModelConfig["thinking"],
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning,
		...(thinking ? { thinking } : {}),
		input,
		cost: ZERO_COST,
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

const allEfforts = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const;
const budgetEfforts = [Effort.Low, Effort.Medium, Effort.High] as const;
const googleLevelThinking: ProviderModelConfig["thinking"] = { mode: "google-level", efforts: allEfforts };
const budgetThinking: ProviderModelConfig["thinking"] = { mode: "budget", efforts: budgetEfforts };
const textAndImage: ProviderModelConfig["input"] = ["text", "image"];
const textOnly: ProviderModelConfig["input"] = ["text"];

export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	model("gemini-3.5-flash-extra-low", "Gemini 3.5 Flash (Low)", true, textAndImage, 1_048_576, googleLevelThinking),
	model("gemini-3.5-flash-low", "Gemini 3.5 Flash (Medium)", true, textAndImage, 1_048_576, googleLevelThinking),
	model("gemini-3-flash-agent", "Gemini 3.5 Flash (High)", true, textAndImage, 1_048_576, googleLevelThinking),
	model("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)", true, textAndImage, DEFAULT_CONTEXT, googleLevelThinking),
	model("gemini-pro-agent", "Gemini 3.1 Pro (High)", true, textAndImage, DEFAULT_CONTEXT, googleLevelThinking),
	model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", true, textAndImage, 200_000, budgetThinking),
	model("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", true, textAndImage, 200_000, budgetThinking),
	model("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", true, textOnly, 200_000, budgetThinking),
	model("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", false, textOnly, DEFAULT_CONTEXT),
];

import { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "opencode-antigravity";
export const BRIDGE_API = "opencode-antigravity-google";
export const GOOGLE_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const OPENCODE_ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	{
		id: "gemini-3.5-flash-extra-low",
		name: "Antigravity Gemini 3.5 Flash Low",
		reasoning: true,
		thinking: { mode: "google-level", minLevel: Effort.Low, maxLevel: Effort.Low, levels: [Effort.Low] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.5-flash-low",
		name: "Antigravity Gemini 3.5 Flash Medium",
		reasoning: true,
		thinking: { mode: "google-level", minLevel: Effort.Medium, maxLevel: Effort.Medium, levels: [Effort.Medium] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3-flash-agent",
		name: "Antigravity Gemini 3.5 Flash High",
		reasoning: true,
		thinking: { mode: "google-level", minLevel: Effort.High, maxLevel: Effort.High, levels: [Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.1-pro-low",
		name: "Antigravity Gemini 3.1 Pro Low",
		reasoning: true,
		thinking: { mode: "google-level", minLevel: Effort.Low, maxLevel: Effort.Low, levels: [Effort.Low] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-3.1-pro-high",
		name: "Antigravity Gemini 3.1 Pro High",
		reasoning: true,
		thinking: { mode: "google-level", minLevel: Effort.High, maxLevel: Effort.High, levels: [Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gpt-oss-120b-medium",
		name: "Antigravity GPT-OSS 120B Medium",
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 32_768,
	},
	{
		id: "antigravity-claude-sonnet-4-6",
		name: "Antigravity Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "antigravity-claude-opus-4-6-thinking",
		name: "Antigravity Claude Opus 4.6 Thinking",
		reasoning: true,
		thinking: { mode: "anthropic-adaptive", minLevel: Effort.Low, maxLevel: Effort.High },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

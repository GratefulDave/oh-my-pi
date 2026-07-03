import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export const PROVIDER_ID = "ag-bridge";
export const BRIDGE_API = "ag-bridge-google";
export const GOOGLE_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const OPENCODE_ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	{
		id: "antigravity-gemini-3.1-pro",
		name: "Antigravity Gemini 3.1 Pro",
		reasoning: true,
		thinking: {
			mode: "google-level",
			efforts: [Effort.Low, Effort.High],
		},
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "antigravity-gemini-3-flash",
		name: "Antigravity Gemini 3 Flash",
		reasoning: true,
		thinking: { mode: "google-level", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash (Antigravity Bridge)",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash Lite (Antigravity Bridge)",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro (Antigravity Bridge)",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash Preview (Antigravity Bridge)",
		reasoning: true,
		thinking: { mode: "google-level", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview (Antigravity Bridge)",
		reasoning: true,
		thinking: {
			mode: "google-level",
			efforts: [Effort.Low, Effort.High],
		},
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity Bridge)",
		reasoning: true,
		thinking: {
			mode: "google-level",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "antigravity-claude-sonnet-4-6",
		name: "Antigravity Claude Sonnet 4.6",
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 65_536,
	},
	{
		id: "antigravity-claude-opus-4-6-thinking",
		name: "Antigravity Claude Opus 4.6 Thinking",
		reasoning: true,
		thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 65_536,
	},
];

import type { ProviderModelConfig } from "../../coding-agent/src/extensibility/extensions/types";

export const PROVIDER_ID = "ag";
export const AG_API = "ag-google-gemini-cli";
export const GOOGLE_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const AG_BASE_URL = GOOGLE_GENERATIVE_LANGUAGE_BASE;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
type ModelThinking = NonNullable<ProviderModelConfig["thinking"]>;
type ThinkingEfforts = ModelThinking["efforts"];
const LOW_HIGH_EFFORTS = ["low", "high"] as unknown as ThinkingEfforts;
const LOW_TO_HIGH_EFFORTS = ["low", "medium", "high"] as unknown as ThinkingEfforts;

const ORDER = [
	"gemini-3.1-pro",
	"gemini-3.5-flash",
	"claude-sonnet-4-6",
	"claude-opus-4-6-thinking",
	"gpt-oss-120b",
	"gpt-oss-20b",
] as const;
const ORDER_INDEX = new Map<string, number>(ORDER.map((id, index) => [id, index]));

export const AG_MODELS: ProviderModelConfig[] = [
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		api: AG_API,
		reasoning: true,
		thinking: { mode: "google-level", efforts: LOW_HIGH_EFFORTS },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: AG_API,
		reasoning: true,
		thinking: { mode: "google-level", efforts: LOW_TO_HIGH_EFFORTS },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: AG_API,
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 65_536,
	},
	{
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking",
		api: AG_API,
		reasoning: true,
		thinking: { mode: "anthropic-adaptive", efforts: LOW_TO_HIGH_EFFORTS },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 65_536,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		api: AG_API,
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 65_536,
	},
	{
		id: "gpt-oss-20b",
		name: "GPT OSS 20B",
		api: AG_API,
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 114_000,
		maxTokens: 32_768,
	},
];

const LEGACY_MODEL_ID_ALIASES = new Map<string, string>([
	["antigravity-gemini-3.1-pro", "gemini-3.1-pro"],
	["gemini-3.1-pro-preview", "gemini-3.1-pro"],
	["gemini-3.1-pro-preview-customtools", "gemini-3.1-pro"],
	["gemini-3.1-pro-low", "gemini-3.1-pro"],
	["gemini-pro-agent", "gemini-3.1-pro"],
	["antigravity-gemini-3-flash", "gemini-3.5-flash"],
	["gemini-3-flash-preview", "gemini-3.5-flash"],
	["gemini-3.5-flash-low", "gemini-3.5-flash"],
	["gemini-3-flash-agent", "gemini-3.5-flash"],
	["antigravity-claude-sonnet-4-6", "claude-sonnet-4-6"],
	["antigravity-claude-opus-4-6-thinking", "claude-opus-4-6-thinking"],
	["gpt-oss-120b-medium", "gpt-oss-120b"],
	["gpt-oss-20b-medium", "gpt-oss-20b"],
]);

export function normalizeAgModelId(modelId: string): string {
	return LEGACY_MODEL_ID_ALIASES.get(modelId) ?? modelId;
}

export function toAgProviderModel(modelId: string, model?: Partial<ProviderModelConfig>): ProviderModelConfig {
	const normalizedId = normalizeAgModelId(modelId);
	const existing = AG_MODELS.find(entry => entry.id === normalizedId);
	if (existing) {
		return { ...existing, ...model, id: normalizedId, api: AG_API };
	}
	return {
		id: normalizedId,
		name: model?.name ?? normalizedId,
		api: AG_API,
		reasoning: model?.reasoning ?? false,
		thinking: model?.thinking,
		input: model?.input ?? ["text"],
		cost: model?.cost ?? ZERO_COST,
		contextWindow: model?.contextWindow ?? 200_000,
		maxTokens: model?.maxTokens ?? 65_536,
		premiumMultiplier: model?.premiumMultiplier,
		compat: model?.compat,
	};
}

export function expandDiscoveredAgModel(model: ProviderModelConfig): ProviderModelConfig[] {
	const normalized = normalizeAgModelId(model.id);
	if (normalized === "gemini-3.5-flash") {
		return [toAgProviderModel("gemini-3.5-flash", model)];
	}
	return [toAgProviderModel(normalized, model)];
}

export function sortAgModels(models: readonly ProviderModelConfig[]): ProviderModelConfig[] {
	const deduped = new Map<string, ProviderModelConfig>();
	for (const model of models) {
		const id = normalizeAgModelId(model.id);
		deduped.set(id, { ...model, id, api: AG_API });
	}
	return [...deduped.values()].sort((left, right) => {
		const leftIndex = ORDER_INDEX.get(left.id) ?? Number.MAX_SAFE_INTEGER;
		const rightIndex = ORDER_INDEX.get(right.id) ?? Number.MAX_SAFE_INTEGER;
		if (leftIndex !== rightIndex) return leftIndex - rightIndex;
		return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
	});
}

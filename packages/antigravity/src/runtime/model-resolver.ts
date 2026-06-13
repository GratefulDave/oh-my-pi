export type AntigravityHeaderStyle = "antigravity" | "gemini-cli";
export type ThinkingTier = "minimal" | "low" | "medium" | "high";

export interface ResolvedAntigravityModel {
	actualModel: string;
	quotaPreference: AntigravityHeaderStyle;
	explicitQuota: boolean;
	isThinkingModel: boolean;
	isImageModel?: boolean;
	thinkingLevel?: ThinkingTier;
	thinkingBudget?: number;
	tier?: ThinkingTier;
}

const THINKING_TIER_BUDGETS = {
	claude: { low: 8192, medium: 16384, high: 32768 },
	"gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
	"gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
	default: { low: 4096, medium: 8192, high: 16384 },
} as const;

const CAPTURED_REQUEST_MODEL_IDS = new Set([
	"gemini-3.5-flash-extra-low",
	"gemini-3.5-flash-low",
	"gemini-3-flash-agent",
	"gemini-3.1-pro-low",
	"gemini-pro-agent",
	"claude-sonnet-4-6",
	"claude-opus-4-6-thinking",
	"gpt-oss-120b-medium",
	"gemini-3.1-flash-lite",
]);

const DEFAULT_THINKING_BUDGETS: Readonly<Record<string, number>> = {
	"gemini-3.5-flash-extra-low": 1000,
	"gemini-3.5-flash-low": 4000,
	"gemini-3-flash-agent": 10000,
	"gemini-3.1-pro-low": 1001,
	"gemini-pro-agent": 10001,
	"claude-sonnet-4-6": 1024,
	"claude-opus-4-6-thinking": 1024,
};

const MODEL_ALIASES: Readonly<Record<string, string>> = {
	"gemini-3.5-flash": "gemini-3.5-flash-low",
	"gemini-3.5-flash-low": "gemini-3.5-flash-extra-low",
	"gemini-3.5-flash-medium": "gemini-3.5-flash-low",
	"gemini-3.5-flash-high": "gemini-3-flash-agent",
	"gemini-3.1-pro": "gemini-3.1-pro-low",
	"gemini-3.1-pro-low": "gemini-3.1-pro-low",
	"gemini-3.1-pro-high": "gemini-pro-agent",
	"claude-sonnet-4-6-thinking": "claude-sonnet-4-6",
	"claude-sonnet-4-6": "claude-sonnet-4-6",
	"claude-opus-4-6": "claude-opus-4-6-thinking",
	"claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
};

const TIER_REGEX = /-(minimal|low|medium|high)$/i;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const IMAGE_GENERATION_MODELS = /image|imagen/i;

export function stripAntigravityProviderPrefix(model: string): string {
	const slash = model.indexOf("/");
	const unqualified = slash >= 0 ? model.slice(slash + 1) : model;
	return unqualified.replace(QUOTA_PREFIX_REGEX, "");
}

export function toVisibleAntigravityModelId(model: string): string {
	return stripAntigravityProviderPrefix(model)
		.replace(/-preview-customtools$/i, "")
		.replace(/^antigravity-/i, "");
}

function supportsThinkingTiers(model: string): boolean {
	const lower = model.toLowerCase();
	return lower.includes("gemini-3") || lower.includes("claude") || lower.includes("gpt-oss-120b");
}

function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
	const lower = model.toLowerCase();
	if (CAPTURED_REQUEST_MODEL_IDS.has(lower)) return undefined;
	if (!supportsThinkingTiers(lower)) return undefined;
	const tier = lower.match(TIER_REGEX)?.[1];
	return isThinkingTier(tier) ? tier : undefined;
}

function isThinkingTier(value: string | undefined): value is ThinkingTier {
	return value === "minimal" || value === "low" || value === "medium" || value === "high";
}

function budgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
	if (model.includes("claude")) return "claude";
	return "default";
}

function isThinkingCapableModel(model: string): boolean {
	const lower = model.toLowerCase();
	return (
		lower.includes("thinking") ||
		lower.includes("claude") ||
		lower.includes("gemini-3") ||
		lower.includes("gpt-oss-120b")
	);
}

function capturedRequestModel(model: string): string | undefined {
	const lower = model.toLowerCase();
	if (CAPTURED_REQUEST_MODEL_IDS.has(lower)) return model;
	return undefined;
}

export function resolveModelWithTier(
	requestedModel: string,
	options: { cli_first?: boolean } = {},
): ResolvedAntigravityModel {
	const qualifiedModel = requestedModel.includes("/")
		? requestedModel.slice(requestedModel.indexOf("/") + 1)
		: requestedModel;
	const isAntigravity = QUOTA_PREFIX_REGEX.test(qualifiedModel);
	const modelWithoutQuota = qualifiedModel.replace(QUOTA_PREFIX_REGEX, "");
	const tier = extractThinkingTierFromModel(modelWithoutQuota);
	const baseName = tier ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;
	const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
	const isClaudeModel = modelWithoutQuota.toLowerCase().includes("claude");
	const exactCapturedModel = capturedRequestModel(modelWithoutQuota) ?? capturedRequestModel(baseName);
	const preferGeminiCli =
		options.cli_first === true && !isAntigravity && !isImageModel && !isClaudeModel && !exactCapturedModel;
	const quotaPreference = preferGeminiCli ? "gemini-cli" : "antigravity";
	const explicitQuota = isAntigravity || isImageModel;
	const actualModel = exactCapturedModel ?? MODEL_ALIASES[modelWithoutQuota] ?? MODEL_ALIASES[baseName] ?? baseName;
	const isThinkingModel = isThinkingCapableModel(actualModel);
	if (isImageModel) return { actualModel, isThinkingModel: false, isImageModel: true, quotaPreference, explicitQuota };

	if (!tier) {
		const thinkingBudget = DEFAULT_THINKING_BUDGETS[actualModel];
		return {
			actualModel,
			...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
			isThinkingModel,
			quotaPreference,
			explicitQuota,
		};
	}

	const budgets = THINKING_TIER_BUDGETS[budgetFamily(actualModel)];
	const budgetTier = tier === "minimal" ? "low" : tier;
	return { actualModel, thinkingBudget: budgets[budgetTier], tier, isThinkingModel, quotaPreference, explicitQuota };
}

export function resolveModelForHeaderStyle(
	requestedModel: string,
	headerStyle: AntigravityHeaderStyle,
): ResolvedAntigravityModel {
	const qualifiedModel = requestedModel.includes("/")
		? requestedModel.slice(requestedModel.indexOf("/") + 1)
		: requestedModel;
	if (headerStyle === "antigravity") {
		const transformedModel = qualifiedModel
			.replace(/-preview-customtools$/i, "")
			.replace(/-preview$/i, "")
			.replace(/^antigravity-/i, "");
		return resolveModelWithTier(`antigravity-${transformedModel}`);
	}

	let transformedModel = qualifiedModel.replace(/^antigravity-/i, "").replace(/-(low|medium|high)$/i, "");
	const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
	if (!hasPreviewSuffix && !capturedRequestModel(transformedModel)) transformedModel = `${transformedModel}-preview`;
	return { ...resolveModelWithTier(transformedModel), quotaPreference: "gemini-cli" };
}

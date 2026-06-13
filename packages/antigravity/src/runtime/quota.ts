import type { Api, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { ANTIGRAVITY_API, GOOGLE_GENERATIVE_LANGUAGE_BASE, PROVIDER_ID } from "../models";
import { ANTIGRAVITY_DEFAULT_PROJECT_ID, ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_NODE_HEADERS } from "./constants";
import { deserializeAntigravityCredentials, parseRefreshParts } from "./credentials";
import { toVisibleAntigravityModelId } from "./model-resolver";

export type AntigravityQuotaGroup = "claude" | "gemini-flash" | "gemini-pro";

export interface AntigravityQuotaExhaustion {
	quotaGroup: AntigravityQuotaGroup;
	remainingFraction: number;
	resetTime?: string;
	resetMs?: number;
}

export type AntigravityDynamicModel = ProviderModelConfig & {
	api: Api;
	provider: string;
	baseUrl: string;
};

interface AvailableModelEntry {
	displayName?: string;
	isInternal?: boolean;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const ANTIGRAVITY_STREAMABLE_MODEL_IDS = new Set([
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

function supportsAntigravityStream(modelId: string): boolean {
	return ANTIGRAVITY_STREAMABLE_MODEL_IDS.has(modelId);
}

export async function fetchAntigravityModels(
	apiKey: string | undefined,
	fetcher: Fetcher = fetch,
): Promise<readonly AntigravityDynamicModel[]> {
	let credentials: OAuthCredentials;
	try {
		credentials = deserializeAntigravityCredentials(apiKey);
	} catch {
		return [];
	}
	const parts = parseRefreshParts(credentials.refresh);
	const project = parts.managedProjectId || parts.projectId || credentials.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
	let response: Response;
	try {
		response = await fetcher(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.access}`,
				"Content-Type": "application/json",
				...ANTIGRAVITY_NODE_HEADERS,
			},
			body: JSON.stringify(project ? { project } : {}),
		});
	} catch {
		return [];
	}
	if (!response.ok) return [];

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return [];
	}
	if (!payload || typeof payload !== "object") return [];
	const models = (payload as Record<string, unknown>).models;
	if (!models || typeof models !== "object" || Array.isArray(models)) return [];

	const result: AntigravityDynamicModel[] = [];
	for (const [rawId, rawEntry] of Object.entries(models)) {
		if (!rawId || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
		const entry = rawEntry as AvailableModelEntry;
		if (entry.isInternal === true) continue;
		const id = toVisibleAntigravityModelId(rawId);
		if (!supportsAntigravityStream(id)) continue;
		const supportsImages = entry.supportsImages === true;
		result.push({
			id,
			name: entry.displayName ?? id,
			api: ANTIGRAVITY_API,
			provider: PROVIDER_ID,
			baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
			reasoning: entry.supportsThinking === true,
			input: supportsImages ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: positiveInt(entry.maxTokens, 200_000),
			maxTokens: positiveInt(entry.maxOutputTokens, 65_536),
		});
	}
	return result;
}

export function classifyQuotaGroup(modelId: string): AntigravityQuotaGroup | null {
	const lower = modelId.toLowerCase();
	if (lower.includes("claude")) return "claude";
	if (lower === "gemini-pro-agent") return "gemini-pro";
	const isGemini3 = lower.includes("gemini-3") || lower.includes("gemini 3");
	if (!isGemini3) return null;
	return lower.includes("flash") ? "gemini-flash" : "gemini-pro";
}

export function quotaExhaustionFromGroup(
	modelId: string,
	group: { remainingFraction?: unknown; resetTime?: unknown } | undefined,
	now = Date.now(),
): AntigravityQuotaExhaustion | null {
	const quotaGroup = classifyQuotaGroup(modelId);
	if (!quotaGroup || !group) return null;
	const remainingFraction =
		typeof group.remainingFraction === "number" && Number.isFinite(group.remainingFraction)
			? group.remainingFraction
			: 0;
	const resetTime = typeof group.resetTime === "string" ? group.resetTime : undefined;
	const resetMs = resetTime ? Date.parse(resetTime) : undefined;
	const resetInFuture = resetMs !== undefined && Number.isFinite(resetMs) && resetMs > now;
	if (remainingFraction > 0 || !resetInFuture) return null;
	return { quotaGroup, remainingFraction, ...(resetTime ? { resetTime } : {}), ...(resetInFuture ? { resetMs } : {}) };
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

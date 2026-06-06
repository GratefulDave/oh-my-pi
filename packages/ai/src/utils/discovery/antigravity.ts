import * as z from "zod/v4";
import {
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_FETCH_AVAILABLE_MODELS_PATH,
	ANTIGRAVITY_SECONDARY_ENDPOINT,
	getAntigravityCodeAssistHeaders,
} from "../../providers/google-gemini-headers";
import type { Model } from "../../types";
import { toPositiveNumber } from "../../utils";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
/**
 * Raw model metadata returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	recommended?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	model?: string;
	apiProvider?: string;
	modelProvider?: string;
	isInternal?: boolean;
	supportsVideo?: boolean;
}

/**
 * Grouping metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelGroup {
	modelIds?: string[];
}

/**
 * Sort/group metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelSort {
	groups?: AntigravityDiscoveryAgentModelGroup[];
}

/**
 * Response payload returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiResponse {
	models?: Record<string, AntigravityDiscoveryApiModel>;
	agentModelSorts?: AntigravityDiscoveryAgentModelSort[];
}
const AntigravityDiscoveryApiModelSchema: z.ZodType<AntigravityDiscoveryApiModel> = z
	.object({
		displayName: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		supportsImages: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		supportsThinking: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		recommended: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		maxTokens: z.preprocess(
			value => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
			z.number().optional(),
		),
		maxOutputTokens: z.preprocess(
			value => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
			z.number().optional(),
		),
		model: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		apiProvider: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		modelProvider: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		isInternal: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		supportsVideo: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
	})
	.loose();
const AntigravityDiscoveryAgentModelGroupSchema: z.ZodType<AntigravityDiscoveryAgentModelGroup> = z
	.object({
		modelIds: z.preprocess(
			value =>
				Array.isArray(value)
					? value.filter((modelId): modelId is string => typeof modelId === "string")
					: undefined,
			z.array(z.string()).optional(),
		),
	})
	.loose();
const AntigravityDiscoveryAgentModelSortSchema: z.ZodType<AntigravityDiscoveryAgentModelSort> = z
	.object({
		groups: z.preprocess(
			value => (Array.isArray(value) ? value : undefined),
			z
				.array(z.unknown())
				.transform(groups =>
					groups.flatMap(group => {
						const parsedGroup = AntigravityDiscoveryAgentModelGroupSchema.safeParse(group);
						return parsedGroup.success ? [parsedGroup.data] : [];
					}),
				)
				.optional(),
		),
	})
	.loose();

const ANTIGRAVITY_CAPTURED_MODEL_DEFS: readonly {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
}[] = [
	{
		id: "gemini-3.5-flash-extra-low",
		name: "Gemini 3.5 Flash Low (Antigravity)",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
	},
	{
		id: "gemini-3.5-flash-low",
		name: "Gemini 3.5 Flash Medium (Antigravity)",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
	},
	{
		id: "gemini-3-flash-agent",
		name: "Gemini 3.5 Flash High (Antigravity)",
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		input: ["text", "image"],
	},
	{
		id: "gemini-3.1-pro-low",
		name: "Gemini 3.1 Pro Low (Antigravity)",
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		input: ["text", "image"],
	},
	{
		id: "gemini-pro-agent",
		name: "Gemini 3.1 Pro High (Antigravity)",
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		input: ["text", "image"],
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 Thinking (Antigravity)",
		contextWindow: 250_000,
		maxTokens: 64_000,
		input: ["text", "image"],
	},
	{
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking (Antigravity)",
		contextWindow: 250_000,
		maxTokens: 64_000,
		input: ["text", "image"],
	},
];

export function getAntigravityStaticModels(endpoint = ANTIGRAVITY_SECONDARY_ENDPOINT): Model<"google-gemini-cli">[] {
	return ANTIGRAVITY_CAPTURED_MODEL_DEFS.map(model => ({
		id: model.id,
		name: model.name,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: endpoint,
		reasoning: false,
		input: [...model.input],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));
}
const AntigravityDiscoveryApiResponseSchema: z.ZodType<AntigravityDiscoveryApiResponse> = z
	.object({
		models: z.preprocess(
			value => (typeof value === "object" && value !== null ? value : undefined),
			z
				.record(z.string(), z.unknown())
				.transform(models => {
					const normalized: Record<string, AntigravityDiscoveryApiModel> = {};
					for (const [modelId, modelValue] of Object.entries(models)) {
						if (typeof modelValue !== "object" || modelValue === null) {
							continue;
						}
						const parsedModel = AntigravityDiscoveryApiModelSchema.safeParse(modelValue);
						if (parsedModel.success) {
							normalized[modelId] = parsedModel.data;
						}
					}
					return normalized;
				})
				.optional(),
		),
		agentModelSorts: z.preprocess(
			value => (Array.isArray(value) ? value : undefined),
			z
				.array(z.unknown())
				.transform(sorts =>
					sorts.flatMap(sort => {
						const parsedSort = AntigravityDiscoveryAgentModelSortSchema.safeParse(sort);
						return parsedSort.success ? [parsedSort.data] : [];
					}),
				)
				.optional(),
		),
	})
	.loose();

/**
 * Options for fetching Antigravity discovery models.
 */
export interface FetchAntigravityDiscoveryModelsOptions {
	/** OAuth access token used as `Authorization: Bearer <token>`. */
	token: string;
	/** Optional endpoint override. Defaults to Antigravity daily/stable endpoints. */
	endpoint?: string;
	/** Cloud Code Assist project id returned by loadCodeAssist. Required for agy-compatible discovery. */
	projectId?: string;
	/** Deprecated and ignored for antigravity discovery parity. */
	project?: string;
	/** Deprecated and ignored; agy parity requires the captured CLI user-agent. */
	userAgent?: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetcher?: typeof fetch;
}

/**
 * Fetches discoverable Antigravity models and normalizes them into canonical model entries.
 *
 * Returns `null` on network/payload/auth failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchAntigravityDiscoveryModels(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<Model<"google-gemini-cli">[] | null> {
	const project = options.projectId?.trim();
	if (!project) {
		return null;
	}
	const fetcher = options.fetcher ?? fetch;
	const endpoints = options.endpoint
		? [trimTrailingSlashes(options.endpoint)]
		: ANTIGRAVITY_ENDPOINTS.map(trimTrailingSlashes);

	for (const endpoint of endpoints) {
		let response: Response;
		try {
			response = await fetcher(`${endpoint}${ANTIGRAVITY_FETCH_AVAILABLE_MODELS_PATH}`, {
				method: "POST",
				headers: getAntigravityCodeAssistHeaders(options.token),
				body: JSON.stringify({ project }),
				signal: options.signal,
			});
		} catch {
			continue;
		}

		if (!response.ok) {
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}

		const parsed = parseAntigravityDiscoveryResponse(payload);
		if (!parsed) {
			continue;
		}

		const models: Model<"google-gemini-cli">[] = [];
		const capturedModelIds = new Set(ANTIGRAVITY_CAPTURED_MODEL_DEFS.map(model => model.id));
		for (const [modelId, model] of Object.entries(parsed.models ?? {})) {
			if (!capturedModelIds.has(modelId) || model.isInternal === true) {
				continue;
			}

			const fallback = ANTIGRAVITY_CAPTURED_MODEL_DEFS.find(candidate => candidate.id === modelId);
			const supportsImages = model.supportsImages ?? fallback?.input.includes("image") ?? false;
			models.push({
				id: modelId,
				name: fallback?.name ?? (model.displayName ? `${model.displayName} (Antigravity)` : modelId),
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: ANTIGRAVITY_SECONDARY_ENDPOINT,
				reasoning: false,
				input: supportsImages ? ["text", "image"] : ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: toPositiveNumber(model.maxTokens, fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
				maxTokens: toPositiveNumber(model.maxOutputTokens, fallback?.maxTokens ?? DEFAULT_MAX_TOKENS),
			});
		}

		models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		return models;
	}

	return null;
}

function parseAntigravityDiscoveryResponse(value: unknown): AntigravityDiscoveryApiResponse | null {
	const parsed = AntigravityDiscoveryApiResponseSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

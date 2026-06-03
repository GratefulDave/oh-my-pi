import type {
	Api,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	OAuthCredentials,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { isJsonObject, type JsonObject, normalizeSchemaForCCA } from "@oh-my-pi/pi-ai/utils/schema";
import type {
	LoaderResult,
	PluginClient,
	PluginResult,
	Provider,
} from "opencode-antigravity-auth/dist/src/plugin/types";
import {
	type BridgeQuotaExhaustion,
	checkBridgeQuotaExhaustion,
	deserializeBridgeCredentials,
	toUpstreamAuthDetails,
} from "./auth-adapter";
import { GOOGLE_GENERATIVE_LANGUAGE_BASE, OPENCODE_ANTIGRAVITY_MODELS, PROVIDER_ID } from "./models";

type UpstreamAuthHook = PluginResult["auth"];

type GoogleStreamModel = Model<"google-generative-ai">;
type GoogleStream = (
	model: GoogleStreamModel,
	context: Context,
	options: SimpleStreamOptions,
) => AssistantMessageEventStream;

// ---------------------------------------------------------------------------
// Upstream tier encoding
// ---------------------------------------------------------------------------

/**
 * Whether the upstream model-resolver recognises thinking-tier suffixes
 * (`-low`, `-medium`, `-high`, …) for this model.
 * Mirrors upstream `supportsThinkingTiers()` in model-resolver.js.
 */
function supportsUpstreamThinkingTier(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return (
		lower.includes("gemini-3") ||
		lower.includes("gemini-2.5") ||
		(lower.includes("claude") && lower.includes("thinking"))
	);
}

/**
 * Maps a pi-ai `Effort` value to the upstream tier suffix string.
 * Upstream accepts: `minimal | low | medium | high`.
 * `xhigh` has no upstream equivalent and is clamped to `high`.
 */
function effortToUpstreamTier(effort: string): string {
	return effort === "xhigh" ? "high" : effort;
}

/**
 * Builds the model ID embedded in the Google API URL path, encoding the
 * user's effort level as a tier suffix so the upstream plugin's
 * `resolveModelWithTier` applies the correct thinking configuration.
 *
 * Also strips `-preview` / `-preview-customtools` suffixes — all bridge
 * requests route through the Antigravity endpoint which expects bare names.
 */
function buildUpstreamModelId(model: Model<Api>, reasoning?: string): string {
	let id = model.id.replace(/-preview-customtools$/i, "").replace(/-preview$/i, "");

	if (reasoning && model.reasoning && supportsUpstreamThinkingTier(id)) {
		id = `${id}-${effortToUpstreamTier(reasoning)}`;
	}
	return id;
}

/**
 * Normalizes the serialised Google request before it enters the upstream
 * Antigravity plugin. The plugin bridges via Cloud Code Assist, whose tool
 * debug path treats `parametersJsonSchema` as a custom schema and rejects it
 * with `hasCustom=true, hasFunction=false`. Send the legacy function schema
 * field instead.
 */
function normalizeBodyForUpstream(init?: RequestInit): RequestInit | undefined {
	if (!init?.body || typeof init.body !== "string") return init;
	try {
		const body = JSON.parse(init.body);
		if (!isJsonObject(body)) return init;

		let changed = stripThinkingConfig(body);
		changed = normalizeToolSchemas(body) || changed;

		return changed ? { ...init, body: JSON.stringify(body) } : init;
	} catch {
		return init;
	}
}

function stripThinkingConfig(body: JsonObject): boolean {
	const generationConfig = body.generationConfig;
	if (!isJsonObject(generationConfig) || !("thinkingConfig" in generationConfig)) return false;
	delete generationConfig.thinkingConfig;
	if (Object.keys(generationConfig).length === 0) {
		delete body.generationConfig;
	}
	return true;
}

function normalizeToolSchemas(body: JsonObject): boolean {
	let changed = normalizeToolList(body.tools);
	const request = body.request;
	if (isJsonObject(request)) {
		changed = normalizeToolList(request.tools) || changed;
	}
	return changed;
}

function normalizeToolList(tools: unknown): boolean {
	if (!Array.isArray(tools)) return false;

	let changed = false;
	for (const tool of tools) {
		if (!isJsonObject(tool) || !Array.isArray(tool.functionDeclarations)) continue;
		for (const declaration of tool.functionDeclarations) {
			if (!isJsonObject(declaration) || !("parametersJsonSchema" in declaration)) continue;

			if (!("parameters" in declaration)) {
				declaration.parameters = normalizeSchemaForCCA(declaration.parametersJsonSchema);
			}
			delete declaration.parametersJsonSchema;
			changed = true;
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createUpstreamLoader(
	auth: UpstreamAuthHook,
	credentials: OAuthCredentials,
): Promise<LoaderResult> {
	const provider: Provider = {
		models: Object.fromEntries(
			OPENCODE_ANTIGRAVITY_MODELS.map(model => [model.id, { cost: { input: 0, output: 0 } }]),
		),
	};
	const loaded = await auth.loader(async () => toUpstreamAuthDetails(credentials), provider);
	if (!isLoaderResult(loaded)) {
		throw new Error("opencode-antigravity-auth did not return a fetch loader for OAuth credentials.");
	}
	return loaded;
}

async function requestToInit(
	input: Request,
	init: RequestInit | undefined,
): Promise<[string, RequestInit | undefined]> {
	const headers = new Headers(init?.headers ?? input.headers);
	headers.delete("x-goog-api-key");
	const nextInit: RequestInit = {
		...init,
		method: init?.method ?? input.method,
		headers,
		signal: init?.signal ?? input.signal,
	};
	if (!init?.body && input.body && input.method !== "GET" && input.method !== "HEAD") {
		nextInit.body = await input.text();
	}
	return [input.url, nextInit];
}

export function createBridgeFetch(upstreamFetch: FetchImpl): FetchImpl {
	return async (input, init) => {
		if (input instanceof Request) {
			const [url, nextInit] = await requestToInit(input, init);
			return upstreamFetch(url, nextInit);
		}
		return upstreamFetch(input, stripApiKeyFromInit(init));
	};
}

export function createOpencodeAntigravityStream(
	auth: UpstreamAuthHook,
	clientOrGoogleStream?: PluginClient | GoogleStream,
	googleStream: GoogleStream = streamGoogle,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const client = typeof clientOrGoogleStream === "function" ? undefined : clientOrGoogleStream;
	const resolvedGoogleStream = typeof clientOrGoogleStream === "function" ? clientOrGoogleStream : googleStream;
	return (model, context, options) => {
		const credentials = deserializeBridgeCredentials(options?.apiKey);
		const upstreamId = buildUpstreamModelId(model, options?.reasoning);
		const stream = resolvedGoogleStream(toGoogleStreamModel(model, upstreamId), context, {
			...options,
			apiKey: "antigravity-adapter",
			fetch: async (input, init) => {
				if (client) {
					const quota = await checkBridgeQuotaExhaustion(credentials, model.id, client);
					if (quota) {
						throw new Error(formatQuotaExhaustionError(model.id, quota));
					}
				}
				const loader = await createUpstreamLoader(auth, credentials);
				return createBridgeFetch(loader.fetch)(input, normalizeBodyForUpstream(init));
			},
		});
		return stream;
	};
}

function formatQuotaExhaustionError(modelId: string, quota: BridgeQuotaExhaustion): string {
	const retryAfterMs = quota.resetMs ? Math.max(0, quota.resetMs - Date.now()) : undefined;
	return [
		`opencode-antigravity quota exhausted for model ${modelId}`,
		`quotaGroup=${quota.quotaGroup}`,
		`remainingFraction=${quota.remainingFraction}`,
		quota.resetTime ? `resetTime=${quota.resetTime}` : undefined,
		retryAfterMs !== undefined ? `retry-after-ms=${retryAfterMs}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join("; ");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toGoogleStreamModel(model: Model<Api>, idOverride?: string): GoogleStreamModel {
	return {
		...model,
		...(idOverride ? { id: idOverride } : {}),
		api: "google-generative-ai",
		provider: PROVIDER_ID,
		baseUrl: model.baseUrl || GOOGLE_GENERATIVE_LANGUAGE_BASE,
	} as GoogleStreamModel;
}

function stripApiKeyFromInit(init: RequestInit | undefined): RequestInit | undefined {
	if (!init?.headers) return init;
	const headers = new Headers(init.headers);
	headers.delete("x-goog-api-key");
	return { ...init, headers };
}

function isLoaderResult(value: unknown): value is LoaderResult {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.apiKey === "string" && typeof candidate.fetch === "function";
}

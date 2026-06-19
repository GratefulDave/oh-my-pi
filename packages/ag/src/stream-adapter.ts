import type {
	LoaderResult,
	PluginClient,
	PluginResult,
	Provider,
} from "opencode-antigravity-auth/dist/src/plugin/types";
import { streamGoogle } from "../../ai/src/providers/google";
import type { OAuthCredentials } from "../../ai/src/registry/oauth/types";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
} from "../../ai/src/types";
import { isJsonObject, type JsonObject, normalizeSchemaForCCA } from "../../ai/src/utils/schema";
import {
	type BridgeQuotaExhaustion,
	checkAgQuotaExhaustion,
	deserializeAgCredentials,
	toUpstreamAuthDetails,
} from "./auth-adapter";
import { AG_BASE_URL, AG_MODELS, normalizeAgModelId, PROVIDER_ID } from "./models";

type UpstreamAuthHook = PluginResult["auth"];
type GoogleStreamModel = Model<"google-generative-ai">;
type GoogleStream = typeof streamGoogle;

function supportsUpstreamThinkingTier(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return (
		lower.includes("gemini-3") ||
		lower.includes("gemini-2.5") ||
		(lower.includes("claude") && lower.includes("thinking"))
	);
}

function effortToUpstreamTier(effort: string): string {
	return effort === "xhigh" ? "high" : effort;
}

function buildUpstreamModelId(model: Model<Api>, reasoning?: string): string {
	const normalizedId = normalizeAgModelId(model.id);
	const canonicalId =
		normalizedId === "gemini-3.5-flash"
			? "antigravity-gemini-3-flash"
			: normalizedId === "gemini-3.1-pro"
				? "antigravity-gemini-3.1-pro"
				: normalizedId === "claude-sonnet-4-6"
					? "antigravity-claude-sonnet-4-6"
					: normalizedId === "claude-opus-4-6-thinking"
						? "antigravity-claude-opus-4-6-thinking"
						: normalizedId;
	let id = canonicalId.replace(/-preview-customtools$/i, "").replace(/-preview$/i, "");
	if (reasoning && model.reasoning && supportsUpstreamThinkingTier(id)) {
		id = `${id}-${effortToUpstreamTier(reasoning)}`;
	}
	return id;
}

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
	if (Object.keys(generationConfig).length === 0) delete body.generationConfig;
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

export async function createUpstreamLoader(
	auth: UpstreamAuthHook,
	credentials: OAuthCredentials,
): Promise<LoaderResult> {
	const provider: Provider = {
		models: Object.fromEntries(AG_MODELS.map(model => [model.id, { cost: { input: 0, output: 0 } }])),
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

export function createAgStream(
	auth: UpstreamAuthHook,
	clientOrGoogleStream?: PluginClient | GoogleStream,
	googleStream: GoogleStream = streamGoogle,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const client = typeof clientOrGoogleStream === "function" ? undefined : clientOrGoogleStream;
	const resolvedGoogleStream = typeof clientOrGoogleStream === "function" ? clientOrGoogleStream : googleStream;
	return (model, context, options) => {
		const credentials = deserializeAgCredentials(typeof options?.apiKey === "string" ? options.apiKey : undefined);
		const upstreamId = buildUpstreamModelId(model, options?.reasoning);
		const stream = resolvedGoogleStream(toGoogleStreamModel(model, upstreamId), context, {
			...options,
			apiKey: "ag-extension",
			fetch: async (input, init) => {
				if (client) {
					const quota = await checkAgQuotaExhaustion(credentials, model.id, client);
					if (quota) throw new Error(formatQuotaExhaustionError(model.id, quota));
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
		`ag quota exhausted for model ${modelId}`,
		`quotaGroup=${quota.quotaGroup}`,
		`remainingFraction=${quota.remainingFraction}`,
		quota.resetTime ? `resetTime=${quota.resetTime}` : undefined,
		retryAfterMs !== undefined ? `retry-after-ms=${retryAfterMs}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join("; ");
}

function toGoogleStreamModel(model: Model<Api>, idOverride?: string): GoogleStreamModel {
	return {
		...model,
		...(idOverride ? { id: idOverride } : {}),
		api: "google-generative-ai",
		provider: PROVIDER_ID,
		baseUrl: model.baseUrl || AG_BASE_URL,
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

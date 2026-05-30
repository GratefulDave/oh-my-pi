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
import type { LoaderResult, PluginResult, Provider } from "opencode-antigravity-auth/dist/src/plugin/types";
import { deserializeBridgeCredentials, toUpstreamAuthDetails } from "./auth-adapter";
import { GOOGLE_GENERATIVE_LANGUAGE_BASE, OPENCODE_ANTIGRAVITY_MODELS, PROVIDER_ID } from "./models";

type FetchInput = string | URL | Request;

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
 * Strips `generationConfig.thinkingConfig` from the serialised request body.
 * The upstream plugin resolves thinking config from the model-name tier
 * suffix; a duplicate config in the body would be double-processed.
 */
function stripBodyThinkingConfig(init?: RequestInit): RequestInit | undefined {
	if (!init?.body || typeof init.body !== "string") return init;
	try {
		const body = JSON.parse(init.body);
		if (body.generationConfig?.thinkingConfig) {
			delete body.generationConfig.thinkingConfig;
			if (Object.keys(body.generationConfig).length === 0) {
				delete body.generationConfig;
			}
		}
		return { ...init, body: JSON.stringify(body) };
	} catch {
		return init;
	}
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

export function createBridgeFetch(upstreamFetch: FetchImpl): FetchImpl {
	return (input, init) => upstreamFetch(stripApiKeyFromRequest(input), stripApiKeyFromInit(init));
}

export function createOpencodeAntigravityStream(
	auth: UpstreamAuthHook,
	googleStream: GoogleStream = streamGoogle,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		const credentials = deserializeBridgeCredentials(options?.apiKey);
		const upstreamId = buildUpstreamModelId(model, options?.reasoning);
		const stream = googleStream(toGoogleStreamModel(model, upstreamId), context, {
			...options,
			apiKey: "antigravity-adapter",
			fetch: async (input, init) => {
				const loader = await createUpstreamLoader(auth, credentials);
				return createBridgeFetch(loader.fetch)(input, stripBodyThinkingConfig(init));
			},
		});
		return stream;
	};
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

function stripApiKeyFromRequest(input: FetchInput): FetchInput {
	if (!(input instanceof Request)) return input;
	const headers = new Headers(input.headers);
	headers.delete("x-goog-api-key");
	return new Request(input, { headers });
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

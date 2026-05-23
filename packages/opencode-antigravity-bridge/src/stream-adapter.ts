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
		const stream = googleStream(toGoogleStreamModel(model), context, {
			...options,
			apiKey: "opencode-antigravity-bridge",
			fetch: async (input, init) => {
				const loader = await createUpstreamLoader(auth, credentials);
				return createBridgeFetch(loader.fetch)(input, init);
			},
		});
		return stream;
	};
}

function toGoogleStreamModel(model: Model<Api>): GoogleStreamModel {
	return {
		...model,
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

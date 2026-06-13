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
import { GOOGLE_GENERATIVE_LANGUAGE_BASE, PROVIDER_ID } from "./models";
import {
	deserializeAntigravityCredentials,
	refreshAntigravityCredentials,
	serializeAntigravityCredentials,
} from "./runtime/credentials";
import { resolveModelForHeaderStyle } from "./runtime/model-resolver";
import { normalizeBodyForAntigravity, prepareAntigravityRequest } from "./runtime/request";
import { THINKING_RECOVERY_NEEDED, transformAntigravityResponse } from "./runtime/response";

type GoogleStreamModel = Model<"google-generative-ai">;
export type GoogleStream = (
	model: GoogleStreamModel,
	context: Context,
	options: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function createAntigravityStream(
	googleStream: GoogleStream = streamGoogle as unknown as GoogleStream,
	fetcher: FetchImpl = fetch,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		let credentials = deserializeOptionsCredentials(options?.apiKey);
		const upstreamId = resolveModelForHeaderStyle(model.id, "antigravity").actualModel;
		return googleStream(toGoogleStreamModel(model, upstreamId), context, {
			...options,
			apiKey: "antigravity-extension",
			fetch: async (input, init) => {
				credentials = await refreshIfNeeded(credentials, fetcher);
				return bridgeFetch(input, normalizeBodyForAntigravity(init), credentials, fetcher, false);
			},
		});
	};
}

export async function bridgeFetch(
	input: string | URL | Request,
	init: RequestInit | undefined,
	credentials: OAuthCredentials,
	fetcher: FetchImpl = fetch,
	forceThinkingRecovery = false,
): Promise<Response> {
	const prepared = await prepareAntigravityRequest(input, init, credentials, { forceThinkingRecovery });
	const response = await fetcher(prepared.request, prepared.init);
	try {
		return await transformAntigravityResponse(response, prepared.streaming, {
			requestedModel: prepared.requestedModel,
			effectiveModel: prepared.effectiveModel,
			projectId: prepared.projectId,
			endpoint: prepared.endpoint,
			sessionId: prepared.sessionId,
		});
	} catch (error) {
		if (error instanceof Error && error.message === THINKING_RECOVERY_NEEDED && !forceThinkingRecovery) {
			return bridgeFetch(input, init, credentials, fetcher, true);
		}
		throw error;
	}
}

async function refreshIfNeeded(credentials: OAuthCredentials, fetcher: FetchImpl): Promise<OAuthCredentials> {
	if (credentials.access && Date.now() < credentials.expires - 30_000) return credentials;
	return refreshAntigravityCredentials(credentials, fetcher);
}

function deserializeOptionsCredentials(apiKey: SimpleStreamOptions["apiKey"]): OAuthCredentials {
	if (typeof apiKey !== "string") throw new Error("Antigravity stream requires serialized OAuth credentials.");
	return deserializeAntigravityCredentials(apiKey);
}

function toGoogleStreamModel(model: Model<Api>, idOverride: string): GoogleStreamModel {
	return {
		...model,
		id: idOverride,
		api: "google-generative-ai",
		provider: PROVIDER_ID,
		baseUrl: model.baseUrl || GOOGLE_GENERATIVE_LANGUAGE_BASE,
	} as GoogleStreamModel;
}

export { normalizeBodyForAntigravity, serializeAntigravityCredentials };

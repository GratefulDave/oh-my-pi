import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ANTIGRAVITY_API, ANTIGRAVITY_MODELS, GOOGLE_GENERATIVE_LANGUAGE_BASE, PROVIDER_ID } from "./models";
import { refreshAntigravityCredentials, serializeAntigravityCredentials } from "./runtime/credentials";
import { loginAntigravity } from "./runtime/oauth";
import { fetchAntigravityModels } from "./runtime/quota";
import { createAntigravityStream } from "./stream-adapter";

export default async function antigravityExtension(pi: ExtensionAPI): Promise<void> {
	pi.setLabel("Antigravity");
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
		api: ANTIGRAVITY_API,
		streamSimple: createAntigravityStream(),
		models: ANTIGRAVITY_MODELS,
		oauth: {
			name: "Antigravity",
			login: loginAntigravity,
			refreshToken: refreshAntigravityCredentials,
			getApiKey: serializeAntigravityCredentials,
		},
		fetchDynamicModels: fetchAntigravityModels,
	});
}

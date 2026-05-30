import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AntigravityCLIOAuthPlugin } from "opencode-antigravity-auth";
import {
	fetchBridgeModels,
	findUpstreamOAuthMethod,
	loginWithUpstreamOAuth,
	refreshBridgeCredentials,
	serializeBridgeCredentials,
} from "./auth-adapter";
import { BRIDGE_API, GOOGLE_GENERATIVE_LANGUAGE_BASE, OPENCODE_ANTIGRAVITY_MODELS, PROVIDER_ID } from "./models";
import { createOpenCodeClientAdapter } from "./opencode-client-adapter";
import { createOpencodeAntigravityStream } from "./stream-adapter";

export default async function opencodeAntigravityBridge(pi: ExtensionAPI): Promise<void> {
	pi.setLabel("OpenCode Antigravity Bridge");

	const client = createOpenCodeClientAdapter(pi);

	const upstream = await AntigravityCLIOAuthPlugin({
		client,
		directory: process.cwd(),
	});
	const oauthMethod = findUpstreamOAuthMethod(upstream.auth.methods);

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
		api: BRIDGE_API,
		streamSimple: createOpencodeAntigravityStream(upstream.auth, client),
		models: OPENCODE_ANTIGRAVITY_MODELS,
		oauth: {
			name: "OpenCode Antigravity",
			login: callbacks => loginWithUpstreamOAuth(oauthMethod, callbacks),
			// Use plugin-compatible refresh so token semantics match the upstream plugin.
			refreshToken: credentials => refreshBridgeCredentials(credentials, client),
			getApiKey: serializeBridgeCredentials,
		},
		fetchModels: fetchBridgeModels,
	});
}

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AntigravityCLIOAuthPlugin } from "opencode-antigravity-auth";
import { findUpstreamOAuthMethod, loginWithUpstreamOAuth, serializeBridgeCredentials } from "./auth-adapter";
import { BRIDGE_API, GOOGLE_GENERATIVE_LANGUAGE_BASE, OPENCODE_ANTIGRAVITY_MODELS, PROVIDER_ID } from "./models";
import { createOpenCodeClientAdapter } from "./opencode-client-adapter";
import { createOpencodeAntigravityStream } from "./stream-adapter";

export default async function opencodeAntigravityBridge(pi: ExtensionAPI): Promise<void> {
	pi.setLabel("OpenCode Antigravity Bridge");

	const upstream = await AntigravityCLIOAuthPlugin({
		client: createOpenCodeClientAdapter(pi),
		directory: process.cwd(),
	});
	const oauthMethod = findUpstreamOAuthMethod(upstream.auth.methods);

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
		api: BRIDGE_API,
		streamSimple: createOpencodeAntigravityStream(upstream.auth),
		models: OPENCODE_ANTIGRAVITY_MODELS,
		oauth: {
			name: "OpenCode Antigravity",
			login: callbacks => loginWithUpstreamOAuth(oauthMethod, callbacks),
			refreshToken: async credentials => credentials,
			getApiKey: serializeBridgeCredentials,
		},
	});
}

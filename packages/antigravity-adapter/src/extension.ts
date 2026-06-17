import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AntigravityCLIOAuthPlugin } from "opencode-antigravity-auth";
import {
	fetchBridgeModels,
	findUpstreamOAuthMethod,
	loginWithUpstreamOAuth,
	probeExistingToken,
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
		directory: pi.cwd,
	});
	const oauthMethod = findUpstreamOAuthMethod(upstream.auth.methods);
	const streamSimple = createOpencodeAntigravityStream(upstream.auth, client) as unknown as NonNullable<
		Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]
	>;

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
		api: BRIDGE_API,
		streamSimple,
		models: OPENCODE_ANTIGRAVITY_MODELS,
		oauth: {
			name: "OpenCode Antigravity",
			login: async callbacks => {
				const probed = await probeExistingToken(client);
				if (probed) return probed;
				return loginWithUpstreamOAuth(oauthMethod, callbacks);
			},
			// Use plugin-compatible refresh so token semantics match the upstream plugin.
			refreshToken: credentials => refreshBridgeCredentials(credentials, client),
			getApiKey: serializeBridgeCredentials,
		},
		fetchDynamicModels: fetchBridgeModels,
	});
}

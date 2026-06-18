import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AntigravityCLIOAuthPlugin } from "opencode-antigravity-auth";
import { loadAccounts } from "opencode-antigravity-auth/dist/src/plugin/storage";
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

	const cwd = (pi as ExtensionAPI & { cwd?: string }).cwd ?? process.cwd();
	const client = createOpenCodeClientAdapter(pi);

	const upstream = await AntigravityCLIOAuthPlugin({
		client,
		directory: cwd,
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

	if (!("registerCommand" in pi) || typeof pi.registerCommand !== "function") return;

	pi.registerCommand("ag", {
		description: "Inspect OpenCode Antigravity bridge OAuth status",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action !== "status") {
				ctx.ui.notify("Usage: /ag status", "warning");
				return;
			}
			try {
				const storage = await loadAccounts();
				const accounts = storage?.accounts ?? [];
				const active = storage ? accounts[storage.activeIndex] : undefined;
				const lines = [
					"Antigravity bridge status:",
					`  accounts: ${accounts.length}`,
					`  active: ${active?.email ?? "(none)"}`,
					`  enabled: ${active?.enabled === false ? "no" : active ? "yes" : "n/a"}`,
					`  refresh token: ${active?.refreshToken ? "present" : "missing"}`,
					`  project: ${active?.managedProjectId ?? active?.projectId ?? "(none)"}`,
				];
				ctx.ui.notify(lines.join("\n"), active?.refreshToken ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`Antigravity status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

import { AntigravityCLIOAuthPlugin } from "opencode-antigravity-auth";
import { loadAccounts } from "opencode-antigravity-auth/dist/src/plugin/storage";
import type { ExtensionAPI } from "../../coding-agent/src/extensibility/extensions/types";
import {
	fetchAgModels,
	findUpstreamOAuthMethod,
	loginWithUpstreamOAuth,
	probeExistingToken,
	refreshAgCredentials,
	serializeAgCredentials,
} from "./auth-adapter";
import { AG_API, AG_BASE_URL, AG_MODELS, PROVIDER_ID } from "./models";
import { createOpenCodeClientAdapter } from "./opencode-client-adapter";
import { createAgStream } from "./stream-adapter";

export default async function agExtension(pi: ExtensionAPI): Promise<void> {
	pi.setLabel("Antigravity (AG extension)");

	const cwd = (pi as ExtensionAPI & { cwd?: string }).cwd ?? process.cwd();
	const client = createOpenCodeClientAdapter(pi);
	const upstream = await AntigravityCLIOAuthPlugin({ client, directory: cwd });
	const oauthMethod = findUpstreamOAuthMethod(upstream.auth.methods);
	const streamSimple = createAgStream(upstream.auth, client) as unknown as NonNullable<
		Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]
	>;

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: AG_BASE_URL,
		api: AG_API,
		streamSimple,
		models: AG_MODELS,
		oauth: {
			name: "Antigravity (AG extension)",
			login: async callbacks => {
				const probed = await probeExistingToken(client);
				if (probed) return probed;
				return loginWithUpstreamOAuth(oauthMethod, callbacks);
			},
			refreshToken: credentials => refreshAgCredentials(credentials, client),
			getApiKey: serializeAgCredentials,
		},
		fetchDynamicModels: fetchAgModels,
	});

	if (!("registerCommand" in pi) || typeof pi.registerCommand !== "function") return;
	pi.registerCommand("ag", {
		description: "Inspect AG OAuth status",
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
					"Antigravity AG status:",
					`  accounts: ${accounts.length}`,
					`  active: ${active?.email ?? "(none)"}`,
					`  enabled: ${active?.enabled === false ? "no" : active ? "yes" : "n/a"}`,
					`  refresh token: ${active?.refreshToken ? "present" : "missing"}`,
					`  project: ${active?.managedProjectId ?? active?.projectId ?? "(none)"}`,
				];
				ctx.ui.notify(lines.join("\n"), active?.refreshToken ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(
					`Antigravity status failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}

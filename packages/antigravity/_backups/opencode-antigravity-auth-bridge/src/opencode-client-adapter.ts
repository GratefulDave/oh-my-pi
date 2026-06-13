import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PluginClient } from "opencode-antigravity-auth/dist/src/plugin/types";

type ToastVariant = "info" | "success" | "warning" | "error";

type ToastInput = {
	body?: {
		title?: string;
		message?: string;
		variant?: ToastVariant;
	};
};

type AuthSetInput = {
	path?: { id?: string };
	body?: unknown;
};

type SessionPromptInput = {
	path?: { id?: string };
	body?: unknown;
	query?: unknown;
};

export function createOpenCodeClientAdapter(pi: Pick<ExtensionAPI, "logger">): PluginClient {
	const client = {
		tui: {
			showToast: async (input: ToastInput): Promise<void> => {
				const title = input.body?.title;
				const message = input.body?.message;
				if (!title && !message) return;
				pi.logger.debug("OpenCode Antigravity toast", {
					variant: input.body?.variant ?? "info",
					message: [title, message].filter(Boolean).join(": "),
				});
			},
		},
		auth: {
			set: async (input: AuthSetInput): Promise<void> => {
				pi.logger.debug("OpenCode Antigravity requested auth storage update", {
					provider: input.path?.id,
					ignored: true,
				});
			},
		},
		session: {
			prompt: async (input: SessionPromptInput): Promise<void> => {
				pi.logger.debug("OpenCode Antigravity requested session recovery prompt", {
					sessionId: input.path?.id,
					ignored: true,
				});
			},
		},
	};

	return client as unknown as PluginClient;
}

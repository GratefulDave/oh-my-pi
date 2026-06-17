// ---------------------------------------------------------------------------
// Swarm dashboard — live TUI overlay showing agent states and mailboxes.
// ---------------------------------------------------------------------------

import { getConfig, getPendingMessages, getQueueLength, type SwarmAgent } from "./mailbox";

// ---------------------------------------------------------------------------
// Minimal Theme interface
// ---------------------------------------------------------------------------

interface SwarmTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

type RequestRender = () => void;
type DoneCallback = () => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateColor(state: SwarmAgent["state"]): string {
	switch (state) {
		case "idle":
			return "success";
		case "working":
			return "warning";
		case "waiting":
			return "accent";
		case "error":
			return "error";
	}
}

/**
 * Match a lone Escape across the terminal input encodings the host may deliver
 * to an overlay component's handleInput():
 *   - legacy bare ESC:        "\x1b"
 *   - Kitty CSI-u:            "\x1b[27u", "\x1b[27;1u" (active Kitty keyboard protocol)
 *   - xterm modifyOtherKeys:  "\x1b[27;1;27~"
 *   - host-normalized token:  "escape" / "esc"
 *
 * The native matchesKey() helper is stubbed to a no-op inside standalone
 * extension bundles, so Escape must be detected directly. Mirrors
 * isEscapeInput() in the pi-observer extension.
 */
function isEscapeInput(data: string): boolean {
	if (data === "escape" || data === "esc" || data === "\x1b") return true;
	return /^\x1b\[(?:27(?:;[0-9]+)*[u~]|27;[0-9;]*27~)$/.test(data);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export class SwarmDashboard {
	#refreshHandle: NodeJS.Timeout | undefined;

	constructor(
		private readonly theme: SwarmTheme,
		readonly requestRender: RequestRender,
		private readonly done: DoneCallback,
	) {
		this.#refreshHandle = setInterval(() => {
			requestRender();
		}, REFRESH_INTERVAL_MS);
	}

	// Host overlays deliver raw key data here. Under the Kitty keyboard protocol
	// a lone Escape arrives as "\x1b[27u" (not bare "\x1b"), so without this the
	// dashboard could not be closed with Esc.
	handleInput(data: string): void {
		if (isEscapeInput(data)) {
			this.destroy();
			this.done();
		}
	}

	act(key: string): boolean {
		if (key === "escape") {
			this.destroy();
			this.done();
			return true;
		}
		return false;
	}

	get height(): number {
		const cfg = getConfig();
		if (!cfg) return 10;
		return 8 + cfg.agents.length * 4;
	}

	layout(_width: number, _height: number): void {}

	render(_width: number): readonly string[] {
		const cfg = getConfig();
		const lines: string[] = [];
		const { fg, bold, dim } = this.theme;

		lines.push("");
		lines.push(bold(fg("accent", "  Swarm Dashboard")));

		if (!cfg) {
			lines.push("");
			lines.push(dim("  No active swarm. Use /swarm init to configure one."));
			lines.push("");
			lines.push(dim("  Press Esc to close"));
			return lines;
		}

		lines.push(dim(`  ${cfg.name} — ${cfg.agents.length} agents — ${cfg.routingPolicy} routing`));
		lines.push("");

		// Agent table
		lines.push(bold("  Agents:"));
		for (const agent of cfg.agents) {
			const isStale = agent.stale;
			const stateIcon = isStale
				? "!"
				: agent.state === "working"
					? "⚙"
					: agent.state === "waiting"
						? "⏳"
						: agent.state === "error"
							? "✗"
							: "●";
			const stateText = isStale ? "stale" : agent.state;
			const queueLen = getQueueLength(agent.id);
			const queueStr = queueLen > 0 ? fg("warning", ` [${queueLen} pending]`) : "";

			lines.push(
				`    ${fg(isStale ? "error" : stateColor(agent.state), stateIcon)} ${bold(agent.id.padEnd(14))} ${dim(agent.role.padEnd(16))} ${dim(`state:${stateText} sent:${agent.sentCount} rcvd:${agent.receivedCount}`)}${queueStr}`,
			);

			if (agent.state === "working" && agent.currentTask) {
				lines.push(`      ${dim("└─")} ${agent.currentTask}`);
			}

			// Show latest 2 pending messages
			const pending = getPendingMessages(agent.id).slice(-2);
			for (const msg of pending) {
				const from = msg.from === "user" ? "you" : msg.from;
				lines.push(
					`      ${dim("✉")} ${dim(`[${msg.priority}]`)} ${dim(`from ${from}:`)} ${msg.subject.slice(0, 40)}`,
				);
			}
		}

		lines.push("");
		lines.push(bold("  Commands:"));
		lines.push(dim("    /swarm-send <agent> <message>  — send message to agent"));
		lines.push(dim("    /swarm-logs export [path]      — export JSONL history"));
		lines.push(dim("    Press Esc to close"));

		return lines;
	}

	destroy(): void {
		if (this.#refreshHandle != null) {
			clearInterval(this.#refreshHandle);
			this.#refreshHandle = undefined;
		}
	}

	dispose(): void {
		this.destroy();
	}
}

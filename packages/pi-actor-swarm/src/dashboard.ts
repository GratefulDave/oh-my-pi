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
			return "green";
		case "working":
			return "yellow";
		case "waiting":
			return "cyan";
		case "error":
			return "red";
	}
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export class SwarmDashboard {
	#refreshHandle: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly theme: SwarmTheme,
		readonly requestRender: RequestRender,
		private readonly done: DoneCallback,
	) {
		this.#refreshHandle = setInterval(() => {
			requestRender();
		}, REFRESH_INTERVAL_MS);
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

	render(_width: number, _height: number): string[] {
		const cfg = getConfig();
		const lines: string[] = [];
		const { fg, bold, dim } = this.theme;

		lines.push("");
		lines.push(bold(fg("cyan", "  Swarm Dashboard")));

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
			const stateIcon =
				agent.state === "working" ? "⚙" : agent.state === "waiting" ? "⏳" : agent.state === "error" ? "✗" : "●";
			const queueLen = getQueueLength(agent.id);
			const queueStr = queueLen > 0 ? fg("yellow", ` [${queueLen} pending]`) : "";

			lines.push(
				`    ${fg(stateColor(agent.state), stateIcon)} ${bold(agent.id.padEnd(14))} ${dim(agent.role.padEnd(16))} ${dim(`sent:${agent.sentCount} rcvd:${agent.receivedCount}`)}${queueStr}`,
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
		lines.push(dim("    /swarm send <agent> <message>  — send message to agent"));
		lines.push(dim("    /swarm init <name>             — initialize swarm"));
		lines.push(dim("    Press Esc to close"));

		return lines;
	}

	destroy(): void {
		if (this.#refreshHandle != null) {
			clearInterval(this.#refreshHandle);
			this.#refreshHandle = undefined;
		}
	}
}

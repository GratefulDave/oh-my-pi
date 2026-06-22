import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

interface DamageRule {
	id: string;
	pattern: string;
	reason: string;
	mode?: "block" | "warn";
}

const DEFAULT_RULES: DamageRule[] = [
	{ id: "rm-root", pattern: "\\brm\\s+-rf\\s+/(?:\\s|$)", reason: "Refuses recursive deletion of filesystem root." },
	{ id: "home-delete", pattern: "\\brm\\s+-rf\\s+(?:~|\\$HOME)(?:\\s|/|$)", reason: "Refuses recursive deletion of the home directory." },
	{ id: "git-force", pattern: "\\bgit\\s+push\\b[\\s\\S]*--force(?!-with-lease)", reason: "Use --force-with-lease, not --force." },
	{ id: "curl-shell", pattern: "\\b(?:curl|wget)\\b[\\s\\S]*\\|\\s*(?:sh|bash|zsh)\\b", reason: "Refuses pipe-to-shell installers." },
	{ id: "secret-env", pattern: "(?:OPENAI|ANTHROPIC|GITHUB|AWS|GOOGLE|ANTIGRAVITY)[A-Z0-9_]*=(?:sk-|ghp_|[A-Za-z0-9_/+=-]{20,})", reason: "Command appears to inline a secret." },
];

// nf-fa-shield \uf132, nf-fa-times \uf00d — nerd-font icons; color applied by the status line renderer
const DAMAGE_ICON = "\uf132";
const DAMAGE_OFF_ICON = "\uf00d";

type DamageMode = "on" | "warn" | "off";

function damageStatusText(mode: DamageMode): string {
	return mode === "off" ? `${DAMAGE_OFF_ICON} damage:` : `${DAMAGE_ICON} damage:`;
}

function damageStatusColor(mode: DamageMode): "success" | "warning" | "error" {
	if (mode === "warn") return "warning";
	if (mode === "off") return "error";
	return "success";
}

export default function damageControlExtension(pi: ExtensionAPI): void {
	pi.setLabel("Damage Control");
	let enabled = true;
	let warnOnly = false;
	let rules = DEFAULT_RULES;

	pi.on("session_start", async (_event, ctx) => {
		rules = await loadRules(ctx.cwd);
		const mode: DamageMode = enabled ? (warnOnly ? "warn" : "on") : "off";
		ctx.ui.setStatus("damage-control", damageStatusText(mode), damageStatusColor(mode));
	});

	pi.registerCommand("damage", {
		description: "Inspect or toggle bash damage-control rules",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "off") {
				enabled = false;
				ctx.ui.setStatus("damage-control", damageStatusText("off"), damageStatusColor("off"));
				ctx.ui.notify("Damage control disabled for this session.", "warning");
				return;
			}
			if (action === "on") {
				enabled = true;
				const mode: DamageMode = warnOnly ? "warn" : "on";
				ctx.ui.setStatus("damage-control", damageStatusText(mode), damageStatusColor(mode));
				ctx.ui.notify("Damage control enabled.", "info");
				return;
			}
			if (action === "warn") {
				warnOnly = true;
				ctx.ui.setStatus("damage-control", damageStatusText("warn"), damageStatusColor("warn"));
				ctx.ui.notify("Damage control warn-only mode enabled.", "info");
				return;
			}
			if (action === "block") {
				warnOnly = false;
				ctx.ui.setStatus("damage-control", damageStatusText("on"), damageStatusColor("on"));
				ctx.ui.notify("Damage control blocking mode enabled.", "info");
				return;
			}
			ctx.ui.notify(formatRules(rules, enabled, warnOnly), "info");
		},
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (!enabled || event.toolName !== "bash") return;
		const command = String(event.input.command ?? "");
		const hit = rules.find(rule => new RegExp(rule.pattern, "i").test(command));
		if (!hit) return;
		const reason = `Damage control ${hit.mode === "warn" || warnOnly ? "warning" : "block"} (${hit.id}): ${hit.reason}`;
		if (hit.mode === "warn" || warnOnly) {
			pi.sendMessage({ customType: "text", content: reason, display: true });
			return;
		}
		return { block: true, reason };
	});
}

async function loadRules(cwd: string): Promise<DamageRule[]> {
	const candidates = [path.join(cwd, ".omp", "damage-control.json"), path.join(os.homedir(), ".omp", "damage-control.json")];
	for (const file of candidates) {
		try {
			const parsed = JSON.parse(await Bun.file(file).text()) as { rules?: DamageRule[] };
			if (Array.isArray(parsed.rules)) return [...DEFAULT_RULES, ...parsed.rules];
		} catch {
			// Missing or invalid custom rules keep defaults active.
		}
	}
	return DEFAULT_RULES;
}

function formatRules(rules: DamageRule[], enabled: boolean, warnOnly: boolean): string {
	return [
		`Damage control: ${enabled ? (warnOnly ? "warn" : "block") : "off"}`,
		...rules.map(rule => `- ${rule.id}: /${rule.pattern}/ — ${rule.reason}`),
	].join("\n");
}

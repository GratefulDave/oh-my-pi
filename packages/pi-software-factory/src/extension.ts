import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { runFactoryDoctor } from "./doctor";
import { scaffoldFactory } from "./scaffold";

export default function softwareFactory(pi: ExtensionAPI): void {
	pi.setLabel("Software Factory");

	// Register slash command: /factory-status
	pi.registerCommand("factory-status", {
		description: "Check factory health and configuration",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const result = await runFactoryDoctor(cwd);

			const lines = [`# Factory Status (${cwd})`, ""];
			for (const check of result.checks) {
				const icon = check.ok ? "✓" : "✗";
				const path = check.path ? `\`${check.path}\`` : "";
				lines.push(`${icon} ${check.message} ${path}`);
			}
			lines.push("", `**Result**: ${result.ok ? "PASSED" : "FAILED"}`);

			ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "warning");
			ctx.ui.setStatus("factory", result.ok ? "Factory: OK" : "Factory: Issues found");
			ctx.ui.setEditorText("");
		},
	});

	// Register slash command: /factory-init
	pi.registerCommand("factory-init", {
		description: "Scaffold a software factory for the current project",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const parts = args.split(/\s+/).filter(Boolean);
			let preset = "standard";
			const presetIdx = parts.indexOf("--preset");
			if (presetIdx !== -1 && parts[presetIdx + 1]) {
				preset = parts[presetIdx + 1];
			}

			ctx.ui.setStatus("factory", `Scaffolding factory (preset: ${preset})...`);

			const result = await scaffoldFactory({ cwd, preset, enableMemory: true });

			const lines = [
				"# Factory Scaffolded",
				`Created ${result.filesWritten.length} file(s):`,
				...result.filesWritten.map(f => `- \`${f}\``),
			];

			if (result.errors.length > 0) {
				lines.push("", "## Errors", ...result.errors.map(e => `- ${e.target}: ${e.error}`));
			}

			ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
			ctx.ui.setStatus("factory", `Factory scaffolded: ${result.filesWritten.length} files created`);
			ctx.ui.setEditorText("");
		},
	});

	// Safety enforcement hook
	pi.on("tool_call", async (_event, ctx) => {
		// Safety rules can be loaded from .omp/factory/safety.rules.json
		// and used to block/warn on dangerous tool calls.
		// For MVP, this is a placeholder for future implementation.
		void ctx;
	});
}

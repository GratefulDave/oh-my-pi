import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildMinimizerGainDiagnostic, exportMinimizerGainJsonl, loadMinimizerGainContext } from "./gain-engine";
import { type DualContext, type GainTheme, MinimizerGainOverlayComponent, type ScopeIndex } from "./overlay";

export { buildMinimizerGainDiagnostic, exportMinimizerGainJsonl, loadMinimizerGainContext } from "./gain-engine";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function minimizerGain(pi: ExtensionAPI): void {
	pi.setLabel("Minimizer Gain");

	pi.registerCommand("gain", {
		description: "Show native minimizer savings for current repo",
		handler: async (args, ctx) => {
			const parsed = parseGainSlashArgs(args);
			const cwd = ctx.cwd;
			if (parsed.exportJsonlPath !== undefined) {
				const context = await loadMinimizerGainContext({ cwd, all: parsed.all, days: parsed.days });
				const exportPath = path.resolve(cwd, parsed.exportJsonlPath);
				await fs.mkdir(path.dirname(exportPath), { recursive: true });
				await fs.writeFile(exportPath, exportMinimizerGainJsonl(context), "utf8");
				ctx.ui.notify(`Minimizer gain JSONL exported to ${exportPath}`, "info");
				return;
			}
			const initialScope: ScopeIndex = parsed.all ? 1 : 0;

			const buildDiagnosticForCwd = async (scopeCwd: string | undefined): Promise<DualContext["diagnostic"]> => {
				try {
					return await buildMinimizerGainDiagnostic({ cwd: scopeCwd, days: parsed.days });
				} catch (err) {
					return { buildError: err instanceof Error ? err.message : String(err) };
				}
			};

			const dualContext: DualContext = {
				current: await loadMinimizerGainContext({ cwd, all: false, days: parsed.days }),
				all: await loadMinimizerGainContext({ cwd, all: true, days: parsed.days }),
				diagnostic: await buildDiagnosticForCwd(initialScope === 0 ? cwd : undefined),
			};

			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new MinimizerGainOverlayComponent(
						theme as GainTheme,
						dualContext,
						() => tui.requestRender(),
						() => done(undefined),
						async () => ({
							current: await loadMinimizerGainContext({ cwd, all: false, days: parsed.days }),
							all: await loadMinimizerGainContext({ cwd, all: true, days: parsed.days }),
							diagnostic: await buildDiagnosticForCwd(initialScope === 0 ? cwd : undefined),
						}),
						initialScope,
					),
				{ overlay: true },
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Argument parsing (shared by handler)
// ---------------------------------------------------------------------------

type GainSlashMode = "summary" | "discover" | "missed";

interface GainSlashArgs {
	all: boolean;
	days?: number;
	mode: GainSlashMode;
	exportJsonlPath?: string;
}

function parseGainSlashArgs(args: string): GainSlashArgs {
	const result: GainSlashArgs = { all: false, mode: "summary" };
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (lower === "--all") {
			result.all = true;
		} else if (lower === "--discover") {
			result.mode = "discover";
		} else if (lower === "--missed") {
			result.mode = "missed";
		}
	}
	for (let i = 0; i < tokens.length; i++) {
		const lower = tokens[i].toLowerCase();
		if ((lower === "--days" || lower === "-d") && i + 1 < tokens.length) {
			const parsed = Number.parseInt(tokens[i + 1], 10);
			if (Number.isFinite(parsed) && parsed > 0) result.days = parsed;
			i += 1;
		} else if (lower === "--export-jsonl") {
			const next = tokens[i + 1];
			result.exportJsonlPath = next && !next.startsWith("-") ? next : ".omp/minimizer-gain-export.jsonl";
			if (next && !next.startsWith("-")) i += 1;
		}
	}
	return result;
}

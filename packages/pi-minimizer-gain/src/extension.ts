import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { buildMinimizerGainDiagnostic, loadMinimizerGainContext } from "./gain-engine";
import { type DualContext, type GainTheme, MinimizerGainOverlayComponent, type ScopeIndex } from "./overlay";

export { buildMinimizerGainDiagnostic, loadMinimizerGainContext } from "./gain-engine";

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
			break;
		}
	}
	return result;
}

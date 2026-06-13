import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildMinimizerGainDiagnostic,
	exportMinimizerGainJsonl,
	getModuleStartedAt,
	loadMinimizerGainContext,
} from "./gain-engine";
import { type DualContext, type GainTheme, MinimizerGainOverlayComponent, type ScopeIndex } from "./overlay";

export {
	buildMinimizerGainDiagnostic,
	exportMinimizerGainJsonl,
	getModuleStartedAt,
	loadMinimizerGainContext,
} from "./gain-engine";

interface GainUi {
	setEditorText(value: string): void;
	notify?(message: string, level: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (
			tui: { requestRender(): void },
			theme: unknown,
			keybindings: unknown,
			done: (value: T) => void,
		) => unknown,
		options: { overlay: boolean },
	): Promise<void>;
}

interface GainCommandContext {
	cwd: string;
	ui: GainUi;
}

interface GainExtensionApi {
	setLabel(value: string): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: GainCommandContext): Promise<void>;
		},
	): void;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function minimizerGain(pi: GainExtensionApi): void {
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
				ctx.ui.notify?.(`Minimizer gain JSONL exported to ${exportPath}`, "info");
				return;
			}
			const initialScope: ScopeIndex = parsed.all ? 2 : 1;

			const buildDiagnosticForCwd = async (scopeCwd: string | undefined): Promise<DualContext["diagnostic"]> => {
				try {
					return await buildMinimizerGainDiagnostic({ cwd: scopeCwd, days: parsed.days });
				} catch (err) {
					return { buildError: err instanceof Error ? err.message : String(err) };
				}
			};

			const sessionStart = getModuleStartedAt();

			const loadSession = () =>
				loadMinimizerGainContext({ cwd, all: false, days: parsed.days, sinceTimestamp: sessionStart });
			const loadCurrent = () => loadMinimizerGainContext({ cwd, all: false, days: parsed.days });
			const loadAll = () => loadMinimizerGainContext({ cwd, all: true, days: parsed.days });

			const [sessionCtx, currentCtx, allCtx, diagnostic] = await Promise.all([
				loadSession(),
				loadCurrent(),
				loadAll(),
				buildDiagnosticForCwd(parsed.all ? undefined : cwd),
			]);

			const dualContext: DualContext = {
				session: sessionCtx,
				current: currentCtx,
				all: allCtx,
				diagnostic,
				sessionStartedAt: sessionStart,
			};

			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new MinimizerGainOverlayComponent(
						theme as GainTheme,
						dualContext,
						() => tui.requestRender(),
						() => done(undefined),
						async (scope, prev) => {
							// Only reload the active scope; keep the others from prev to avoid
							// pointless JSONL reads (especially when session is empty).
							const [newSession, newCurrent, newAll, newDiag] = await Promise.all([
								scope === 0 ? loadSession() : Promise.resolve(prev.session),
								scope === 1 ? loadCurrent() : Promise.resolve(prev.current),
								scope === 2 ? loadAll() : Promise.resolve(prev.all),
								buildDiagnosticForCwd(scope <= 1 ? cwd : undefined),
							]);
							return {
								session: newSession,
								current: newCurrent,
								all: newAll,
								diagnostic: newDiag,
								sessionStartedAt: sessionStart,
							};
						},
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

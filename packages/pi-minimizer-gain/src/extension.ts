import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	type ActiveSessionCommand,
	buildMinimizerGainDiagnostic,
	exportMinimizerGainJsonl,
	loadMinimizerGainContext,
} from "./gain-engine";
import { type DualContext, type GainTheme, MinimizerGainOverlayComponent, type ScopeIndex } from "./overlay";

export { buildMinimizerGainDiagnostic, exportMinimizerGainJsonl, loadMinimizerGainContext } from "./gain-engine";

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
function getActiveSessionHeader(header: { id?: string; timestamp?: string } | null): {
	id: string | undefined;
	startedAt: string | undefined;
} {
	return {
		id: typeof header?.id === "string" ? header.id : undefined,
		startedAt: typeof header?.timestamp === "string" ? header.timestamp : undefined,
	};
}

function extractActiveSessionBashCommands(entries: readonly unknown[], sessionCwd: string): ActiveSessionCommand[] {
	const commands: ActiveSessionCommand[] = [];
	for (const entry of entries) {
		const event = asJsonObject(entry);
		const message = asJsonObject(event?.message);
		const content = message?.content;
		const parts = Array.isArray(content) ? content : [content];
		for (const part of parts) {
			const toolCall = asJsonObject(part);
			if (!toolCall) continue;
			if (toolCall.name !== "bash") continue;
			if (toolCall.type !== "toolCall" && toolCall.type !== "tool_use") continue;
			const input = asJsonObject(toolCall.arguments) ?? asJsonObject(toolCall.input);
			if (!input || typeof input.command !== "string") continue;
			const commandCwd = typeof input.cwd === "string" ? path.resolve(sessionCwd, input.cwd) : sessionCwd;
			commands.push({ command: input.command, cwd: commandCwd });
		}
	}
	return commands;
}

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
			const activeSessionFile = ctx.sessionManager.getSessionFile();
			const initialScope: ScopeIndex = parsed.all ? 2 : 0;

			const buildDiagnosticForCwd = async (
				scopeCwd: string | undefined,
				sessionFile: string | undefined,
				sessionId: string | undefined,
				sessionStartedAt: string | undefined,
				sessionCommands: ActiveSessionCommand[] | undefined,
			): Promise<DualContext["diagnostic"]> => {
				try {
					return await buildMinimizerGainDiagnostic({
						cwd: scopeCwd,
						days: parsed.days,
						activeSessionFile: sessionFile,
						activeSessionId: sessionId,
						activeSessionStartedAt: sessionStartedAt,
						activeSessionCommands:
							sessionId === undefined && sessionStartedAt === undefined ? sessionCommands : undefined,
					});
				} catch (err) {
					return { buildError: err instanceof Error ? err.message : String(err) };
				}
			};

			const loadDualContext = async (): Promise<DualContext> => {
				const activeSession = getActiveSessionHeader(ctx.sessionManager.getHeader());
				const activeSessionCommands = extractActiveSessionBashCommands(ctx.sessionManager.getEntries(), cwd);
				return {
					active: await loadMinimizerGainContext({
						cwd,
						all: false,
						days: parsed.days,
						activeSessionFile,
						activeSessionId: activeSession.id,
						activeSessionStartedAt: activeSession.startedAt,
						activeSessionCommands:
							activeSession.id === undefined && activeSession.startedAt === undefined
								? activeSessionCommands
								: undefined,
					}),
					current: await loadMinimizerGainContext({ cwd, all: false, days: parsed.days }),
					all: await loadMinimizerGainContext({ cwd, all: true, days: parsed.days }),
					diagnostic: await buildDiagnosticForCwd(
						initialScope === 2 ? undefined : cwd,
						initialScope === 0 ? activeSessionFile : undefined,
						initialScope === 0 ? activeSession.id : undefined,
						initialScope === 0 ? activeSession.startedAt : undefined,
						initialScope === 0 && activeSession.id === undefined && activeSession.startedAt === undefined
							? activeSessionCommands
							: undefined,
					),
				};
			};

			const dualContext = await loadDualContext();

			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new MinimizerGainOverlayComponent(
						theme as GainTheme,
						dualContext,
						() => tui.requestRender(),
						() => done(undefined),
						loadDualContext,
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

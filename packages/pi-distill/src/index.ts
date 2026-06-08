/**
 * pi-distill — MCP tool-output compressor for Pi / oh-my-pi (OMP).
 *
 * Large JSON/YAML returned by MCP / custom tools enters the model context window
 * raw and full: those tools are wrapped by ExtensionToolWrapper and never pass
 * through OMP's native `wrapToolWithMetaNotice` → `spillLargeResultToArtifact`,
 * which only covers builtins (bash/read/fetch/grep/…). pi-distill fills that gap.
 *
 * On every tool_result it:
 *   1. skips builtins (native spill owns them), verbatim-listed tools, and any
 *      result already carrying a native `artifactId`;
 *   2. sniffs each text part for JSON/YAML and structurally compresses it;
 *   3. spills the FULL original to a session artifact BEFORE replacing it, then
 *      footers the compact view with `artifact://<id>` so the model can recover
 *      every elided element. If the spill fails, the raw part passes through —
 *      pi-distill never elides anything it cannot recover.
 *
 * Commands: /distill (toggle), /distill-stats (bytes saved this session).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

import { type CompressOpts, compressData } from "./compress";
import { type DistillConfig, loadConfig } from "./config";
import { showGainView } from "./gain-view";
import { parseStructured } from "./sniff";
import { flush, recordHit } from "./stats";

export default function piDistill(pi: ExtensionAPI) {
	const cfg: DistillConfig = loadConfig();
	const opts: CompressOpts = {
		arrayHead: cfg.arrayHead,
		arrayTail: cfg.arrayTail,
		scalarMax: cfg.scalarMax,
	};

	let enabled = true;
	let savedBytes = 0;
	let hits = 0;

	pi.registerCommand("distill", {
		description: "Toggle pi-distill MCP JSON/YAML output compression",
		handler: async (_args, ctx: ExtensionContext) => {
			enabled = !enabled;
			ctx.ui.notify(`pi-distill ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("distill-stats", {
		description: "Show pi-distill bytes saved this session",
		handler: async (_args, ctx: ExtensionContext) => {
			const kb = (savedBytes / 1024).toFixed(1);
			ctx.ui.notify(`pi-distill: ${kb} KB saved across ${hits} tool results`, "info");
		},
	});

	pi.registerCommand("distill-gain", {
		description: "Show pi-distill savings — this project + global, with per-session history",
		handler: async (_args, ctx: ExtensionContext) => {
			await showGainView(ctx);
		},
	});

	// Persist accumulated stats on session end / agent end (best-effort, never throws).
	pi.on("session_shutdown", () => {
		void flush();
	});
	pi.on("agent_end", () => {
		void flush();
	});

	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		if (!enabled || event.isError) return;

		// MCP-only: builtins are handled by the native artifact spill; never touch
		// verbatim-listed tools.
		if (cfg.builtinSkip.has(event.toolName)) return;
		if (cfg.verbatimTools.has(event.toolName)) return;

		// A result already spilled+truncated natively carries an artifactId; its
		// text is byte-chopped, so don't try to re-parse it.
		const details = event.details as { meta?: { truncation?: { artifactId?: string } } } | undefined;
		if (details?.meta?.truncation?.artifactId) return;

		const saveArtifact = ctx.sessionManager?.saveArtifact?.bind(ctx.sessionManager);

		let changed = false;
		const out: (TextContent | ImageContent)[] = [];

		for (const part of event.content) {
			if (part.type !== "text") {
				out.push(part);
				continue;
			}

			const before = Buffer.byteLength(part.text, "utf8");
			if (before < cfg.minBytes) {
				out.push(part);
				continue;
			}

			const parsed = await parseStructured(part.text);
			if (!parsed) {
				out.push(part);
				continue;
			}

			const result = compressData(parsed.data, parsed.stringify, before, opts);
			if (!result) {
				out.push(part);
				continue;
			}

			// Save FULL original before eliding — fail-safe: on any failure, leave
			// the part untouched so nothing is lost.
			let artifactId: string | undefined;
			if (saveArtifact) {
				try {
					artifactId = await saveArtifact(part.text, "pi-distill");
				} catch {
					artifactId = undefined;
				}
			}
			if (!artifactId) {
				out.push(part);
				continue;
			}

			const footer =
				`\n\n[pi-distill: ${parsed.kind} compressed, ${result.elided} nodes elided. ` +
				`Full output: artifact://${artifactId} — read it to recover dropped detail.]`;

			changed = true;
			savedBytes += result.saved;
			hits++;
			recordHit(ctx, result.saved); // persist to per-project + global stores (debounced, fail-safe)
			out.push({ ...part, text: result.body + footer });
		}

		if (!changed) return;
		return { content: out };
	});
}

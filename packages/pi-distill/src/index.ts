import { byteLength, compressNode, type DistillOptions, wrapCompressed } from "./compress";
import { type DistillConfig, loadConfig } from "./config";
import { type GainContext, showGainView } from "./gain-view";
import { parseStructured, type StructuredPayload } from "./sniff";
import { aggregate, flush, recordCandidate, recordHit, type ToolStats } from "./stats";

interface TextPart {
	type: "text";
	text: string;
}

interface ImagePart {
	type: "image";
	data?: string;
	mimeType?: string;
}

type ContentPart = TextPart | ImagePart;

interface MCPRawTextContent {
	type: "text";
	text: string;
}

interface MCPRawResourceContent {
	type: "resource";
	resource?: {
		uri?: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

type MCPRawContent = MCPRawTextContent | MCPRawResourceContent | { type: string };

interface MCPDetails {
	serverName?: unknown;
	mcpToolName?: unknown;
	rawContent?: unknown;
	meta?: {
		truncation?: {
			artifactId?: unknown;
		};
	};
}

export interface DistillSessionManager {
	getArtifactsDir?: () => string | null;
	saveArtifact?: (content: string, toolType: string) => Promise<string | undefined>;
	getArtifactPath?: (id: string) => Promise<string | null>;
	getSessionId?: () => string;
	getCwd?: () => string;
	getSessionName?: () => string | undefined;
}

export interface DistillContext extends GainContext {
	sessionManager?: DistillSessionManager;
}

interface PiCommand {
	description: string;
	handler: (args: string[], ctx: DistillContext) => Promise<void>;
}

interface PiApi {
	registerCommand: (name: string, command: PiCommand) => void;
	on: (
		event: "session_shutdown" | "agent_end" | "tool_result",
		handler: (
			event: DistillToolResultEvent,
			ctx: DistillContext,
		) => Promise<DistillReplacement | undefined> | undefined,
	) => void;
}

export interface DistillToolResultEvent {
	toolName: string;
	content: ContentPart[];
	details?: unknown;
	isError: boolean;
}

export interface DistillReplacement {
	content: ContentPart[];
	details?: unknown;
}

export interface DistillRuntimeState {
	savedBytes: number;
	hits: number;
}

interface ReplacementCandidate {
	text: string;
	parsed: StructuredPayload;
	originalBytes: number;
}

interface TextCompression {
	text: string;
	savedBytes: number;
	originalBytes: number;
	replacementBytes: number;
}
const FORCE_CONSIDER_TOOLS = new Set(["ast_grep"]);

function shouldConsiderTool(toolName: string): boolean {
	return FORCE_CONSIDER_TOOLS.has(toolName);
}

function shouldAllowTool(toolName: string, cfg: DistillConfig): boolean {
	if (cfg.builtinSkip.has(toolName)) return false;
	if (cfg.verbatimTools.has(toolName)) return false;
	return cfg.whitelistTools === null || cfg.whitelistTools.has(toolName);
}

function shouldConsiderText(toolName: string, text: string, cfg: DistillConfig): boolean {
	return shouldConsiderTool(toolName) || byteLength(text) >= cfg.minBytes;
}

function displayContentText(details: unknown): string | null {
	if (!details || typeof details !== "object" || !("displayContent" in details)) return null;
	const displayContent = (details as { displayContent?: unknown }).displayContent;
	return typeof displayContent === "string" ? displayContent : null;
}

function isDetails(value: unknown): value is MCPDetails {
	return Boolean(value && typeof value === "object");
}

function isAlreadyArtifactTruncated(details: unknown): boolean {
	return isDetails(details) && Boolean(details.meta?.truncation?.artifactId);
}

function isMcpEvent(event: DistillToolResultEvent): boolean {
	if (event.toolName.startsWith("mcp__")) return true;
	if (!isDetails(event.details)) return false;
	return typeof event.details.serverName === "string" || typeof event.details.mcpToolName === "string";
}

function rawContentItems(details: unknown): MCPRawContent[] {
	if (!isDetails(details) || !Array.isArray(details.rawContent)) return [];
	return details.rawContent.filter((item): item is MCPRawContent =>
		Boolean(item && typeof item === "object" && "type" in item),
	);
}

function rawTextCandidates(details: unknown): string[] {
	const texts: string[] = [];
	for (const item of rawContentItems(details)) {
		if (item.type === "text" && typeof (item as MCPRawTextContent).text === "string") {
			texts.push((item as MCPRawTextContent).text);
		} else if (item.type === "resource") {
			const text = (item as MCPRawResourceContent).resource?.text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts;
}

async function artifactIdFor(ctx: DistillContext, originalText: string): Promise<string | null> {
	const sessionManager = ctx.sessionManager;
	if (!sessionManager?.getArtifactsDir?.()) return null;
	if (!sessionManager.saveArtifact || !sessionManager.getArtifactPath) return null;
	let artifactId: string | undefined;
	try {
		artifactId = await sessionManager.saveArtifact(originalText, "pi-distill");
	} catch {
		return null;
	}
	if (!artifactId) return null;
	try {
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		return artifactPath ? artifactId : null;
	} catch {
		return null;
	}
}

function isDefinitelyStructuredText(text: string): boolean {
	const trimmed = text.trimStart();
	const looksLikeYamlMap = /^[A-Za-z_.-][\w.-]*:\s/m.test(trimmed);
	return (
		trimmed.startsWith("{") ||
		trimmed.startsWith("[") ||
		/^```(?:\s*(?:json|ya?ml))?\s*\n/i.test(trimmed) ||
		/^---\s*$/m.test(text) ||
		looksLikeYamlMap
	);
}

function isDistillWrapped(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const marker = (value as { __pi_distill?: unknown }).__pi_distill;
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
	return typeof (marker as { artifact?: unknown }).artifact === "string";
}

function replacementText(candidate: ReplacementCandidate, artifactId: string, opts: DistillOptions): string | null {
	const compressed = compressNode(candidate.parsed.data, opts);
	if (compressed.elided === 0) return null;
	const wrapped = wrapCompressed(compressed.value, {
		artifact: `artifact://${artifactId}`,
		elided: compressed.elided,
		originalBytes: candidate.originalBytes,
		recover: `Read artifact://${artifactId} for the complete structured tool output if more context is needed.`,
	});
	return candidate.parsed.stringify(wrapped);
}

async function compressedReplacement(
	candidateText: string,
	originalText: string,
	ctx: DistillContext,
	opts: DistillOptions,
): Promise<TextCompression | null> {
	const originalBytes = byteLength(originalText);
	const parsed = parseStructured(candidateText);
	if (!parsed || isDistillWrapped(parsed.data)) return null;
	const artifactId = await artifactIdFor(ctx, originalText);
	if (!artifactId) return null;
	const text = replacementText({ text: candidateText, parsed, originalBytes }, artifactId, opts);
	if (!text) return null;
	const replacementBytes = byteLength(text);
	if (replacementBytes >= originalBytes) return null;
	return { text, savedBytes: originalBytes - replacementBytes, originalBytes, replacementBytes };
}

function compressedPlainText(
	originalText: string,
	artifactId: string,
	toolName: string,
	opts: DistillOptions,
): TextCompression | null {
	const originalBytes = byteLength(originalText);
	const lines = originalText.split("\n");
	const compressed = compressNode(
		{
			tool: toolName,
			lines,
		},
		opts,
	);
	if (compressed.elided === 0) return null;
	const wrapped = wrapCompressed(compressed.value, {
		artifact: `artifact://${artifactId}`,
		elided: compressed.elided,
		originalBytes,
		recover: `Read artifact://${artifactId} for the complete ${toolName} output if more context is needed.`,
	});
	const text = JSON.stringify(wrapped, null, 2);
	const replacementBytes = byteLength(text);
	if (replacementBytes >= originalBytes) return null;
	return { text, savedBytes: originalBytes - replacementBytes, originalBytes, replacementBytes };
}

async function compressedTextFallback(
	originalText: string,
	toolName: string,
	ctx: DistillContext,
	opts: DistillOptions,
): Promise<TextCompression | null> {
	const artifactId = await artifactIdFor(ctx, originalText);
	return artifactId ? compressedPlainText(originalText, artifactId, toolName, opts) : null;
}

function detailsWithDisplayContent(details: unknown, text: string): unknown {
	if (!details || typeof details !== "object") return details;
	return { ...details, displayContent: text };
}

function recordReplacement(
	ctx: DistillContext,
	state: DistillRuntimeState,
	toolName: string,
	replacement: TextCompression,
): void {
	state.savedBytes += replacement.savedBytes;
	state.hits += 1;
	recordHit(ctx, toolName, replacement.savedBytes, replacement.originalBytes, replacement.replacementBytes);
}

function formatToolStats(tools: Record<string, ToolStats> | undefined): string {
	if (!tools) return "";
	const entries = Object.entries(tools)
		.filter(([, stats]) => stats.candidates > 0 || stats.hits > 0 || stats.savedBytes > 0)
		.sort(
			([leftName, left], [rightName, right]) =>
				right.savedBytes - left.savedBytes || right.hits - left.hits || leftName.localeCompare(rightName),
		)
		.slice(0, 5);
	if (entries.length === 0) return "";
	return `; tools: ${entries
		.map(
			([name, stats]) =>
				`${name}: ${stats.candidates} candidates, ${stats.hits} hits, ${(stats.savedBytes / 1024).toFixed(1)} KB saved`,
		)
		.join("; ")}`;
}

function currentSessionTools(ctx: DistillContext): Record<string, ToolStats> | undefined {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (!sessionId) return undefined;
	return aggregate(ctx).sessions.find(session => session.sessionId === sessionId)?.tools;
}

export async function processToolResult(
	event: DistillToolResultEvent,
	ctx: DistillContext,
	cfg: DistillConfig,
	opts: DistillOptions,
	state: DistillRuntimeState,
): Promise<DistillReplacement | undefined> {
	if (event.isError) return undefined;
	if (!shouldAllowTool(event.toolName, cfg)) return undefined;

	const contentText = event.content
		.filter((part): part is TextPart => part.type === "text")
		.map(part => part.text)
		.join("\n\n");
	const displayText = displayContentText(event.details);
	if (isAlreadyArtifactTruncated(event.details) && !(shouldConsiderTool(event.toolName) && displayText))
		return undefined;
	const originalText =
		displayText && byteLength(displayText) > byteLength(contentText) && shouldConsiderTool(event.toolName)
			? displayText
			: contentText;
	if (!shouldConsiderText(event.toolName, originalText, cfg)) return undefined;
	recordCandidate(ctx, event.toolName);

	if (isMcpEvent(event)) {
		for (const candidate of rawTextCandidates(event.details)) {
			if (!shouldConsiderText(event.toolName, candidate, cfg)) continue;
			const replacement = await compressedReplacement(candidate, originalText, ctx, opts);
			if (!replacement) continue;
			recordReplacement(ctx, state, event.toolName, replacement);
			return {
				content: [{ type: "text", text: replacement.text }],
				details: detailsWithDisplayContent(event.details, replacement.text),
			};
		}

		const fallbackText = displayText && byteLength(displayText) > byteLength(contentText) ? displayText : contentText;
		if (!shouldConsiderText(event.toolName, fallbackText, cfg)) return undefined;
		const structured = isDefinitelyStructuredText(fallbackText) ? parseStructured(fallbackText) : null;
		if (structured && isDistillWrapped(structured.data)) return undefined;
		const replacement =
			(structured ? await compressedReplacement(fallbackText, originalText, ctx, opts) : null) ??
			(await compressedTextFallback(fallbackText, event.toolName, ctx, opts));
		if (!replacement) return undefined;
		recordReplacement(ctx, state, event.toolName, replacement);
		return {
			content: [{ type: "text", text: replacement.text }],
			details: detailsWithDisplayContent(event.details, replacement.text),
		};
	}

	let changed = false;
	const out: ContentPart[] = [];
	for (const part of event.content) {
		if (part.type !== "text") {
			out.push(part);
			continue;
		}
		const candidateText = shouldConsiderTool(event.toolName) && displayText ? displayText : part.text;
		if (!shouldConsiderText(event.toolName, candidateText, cfg)) {
			out.push(part);
			continue;
		}
		const structured = isDefinitelyStructuredText(candidateText) ? parseStructured(candidateText) : null;
		if (structured && isDistillWrapped(structured.data)) {
			out.push(part);
			continue;
		}
		const structuredReplacement = structured
			? await compressedReplacement(candidateText, originalText, ctx, opts)
			: null;
		const replacement =
			structuredReplacement ?? (await compressedTextFallback(candidateText, event.toolName, ctx, opts));
		if (!replacement) {
			out.push(part);
			continue;
		}
		changed = true;
		recordReplacement(ctx, state, event.toolName, replacement);
		out.push({ ...part, text: replacement.text });
	}

	return changed
		? {
				content: out,
				details: detailsWithDisplayContent(
					event.details,
					out.map(part => (part.type === "text" ? part.text : "")).join("\n\n"),
				),
			}
		: undefined;
}

export default function piDistill(pi: PiApi): void {
	const cfg = loadConfig();
	const opts = {
		arrayHead: cfg.arrayHead,
		arrayTail: cfg.arrayTail,
		scalarMax: cfg.scalarMax,
	};
	const state = { savedBytes: 0, hits: 0 };
	let enabled = true;

	pi.registerCommand("distill", {
		description: "Toggle pi-distill MCP JSON/YAML output compression",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui?.notify?.(`pi-distill ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("distill-stats", {
		description: "Show pi-distill bytes saved this session",
		handler: async (_args, ctx) => {
			const toolStats = formatToolStats(currentSessionTools(ctx));
			ctx.ui?.notify?.(
				`pi-distill: ${(state.savedBytes / 1024).toFixed(1)} KB saved across ${state.hits} tool results${toolStats}`,
				"info",
			);
		},
	});

	pi.registerCommand("distill-gain", {
		description: "Show pi-distill savings — this project + global, with per-session history",
		handler: async (_args, ctx) => {
			await showGainView(ctx);
		},
	});

	pi.on("session_shutdown", () => {
		flush();
	});
	pi.on("agent_end", () => {
		flush();
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return undefined;
		return processToolResult(event, ctx, cfg, opts, state);
	});
}

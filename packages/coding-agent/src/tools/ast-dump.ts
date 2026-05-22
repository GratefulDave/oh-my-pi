import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { astDump } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import type { Theme } from "../modes/theme/theme";
import astDumpDescription from "../prompts/tools/ast-dump.md" with { type: "text" };
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { hasGlobPathChars, normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { formatErrorMessage, PREVIEW_LIMITS } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astDumpSchema = z
	.object({
		code: z.string().describe("source code to parse").optional(),
		path: z.string().describe("file or internal URL to parse").optional(),
		lang: z.string().describe("language override").optional(),
	})
	.superRefine((params, ctx) => {
		const hasCode = typeof params.code === "string" && params.code.length > 0;
		const hasPath = typeof params.path === "string" && params.path.trim().length > 0;
		if (hasCode === hasPath) {
			ctx.addIssue({
				code: "custom",
				message: "Provide exactly one of `code` or `path`",
				path: hasCode ? ["path"] : ["code"],
			});
		}
	});

export interface AstDumpToolDetails {
	language: string;
	hasErrors: boolean;
	path?: string;
	tree: string;
	meta?: OutputMeta;
}

async function resolveDumpPath(rawPath: string, cwd: string): Promise<string> {
	const normalized = normalizePathLikeInput(rawPath);
	if (normalized.length === 0) throw new ToolError("`path` must be non-empty");
	if (hasGlobPathChars(normalized)) throw new ToolError("`path` must be a single file, not a glob");

	const internalRouter = InternalUrlRouter.instance();
	if (internalRouter.canHandle(normalized)) {
		const resource = await internalRouter.resolve(normalized);
		if (!resource.sourcePath) {
			throw new ToolError(`Cannot dump internal URL without a backing file: ${normalized}`);
		}
		return resource.sourcePath;
	}
	return resolveToCwd(normalized, cwd);
}

export class AstDumpTool implements AgentTool<typeof astDumpSchema, AstDumpToolDetails> {
	readonly name = "ast_dump";
	readonly label = "AST Dump";
	readonly summary = "Dump a tree-sitter syntax tree";
	readonly description: string;
	readonly parameters = astDumpSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astDumpDescription);
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof astDumpSchema>,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstDumpToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstDumpToolDetails>> {
		return untilAborted(signal, async () => {
			const lang = params.lang?.trim() || undefined;
			if (params.code !== undefined && params.code.length > 0) {
				if (!lang) throw new ToolError("`lang` is required when dumping inline `code`");
				const result = await astDump({ code: params.code, lang, signal });
				const details: AstDumpToolDetails = {
					language: result.language,
					hasErrors: result.hasErrors,
					tree: result.tree,
				};
				return toolResult(details)
					.text(`language: ${result.language}\nhasErrors: ${result.hasErrors}\n${result.tree}`)
					.done();
			}

			if (params.path === undefined) throw new ToolError("Provide exactly one of `code` or `path`");
			const resolvedPath = await resolveDumpPath(params.path, this.session.cwd);
			const result = await astDump({ path: resolvedPath, lang, signal });
			const details: AstDumpToolDetails = {
				language: result.language,
				hasErrors: result.hasErrors,
				path: params.path,
				tree: result.tree,
			};
			return toolResult(details)
				.text(`path: ${params.path}\nlanguage: ${result.language}\nhasErrors: ${result.hasErrors}\n${result.tree}`)
				.done();
		});
	}
}

interface AstDumpRenderArgs {
	code?: string;
	path?: string;
	lang?: string;
}

const COLLAPSED_TREE_LINES = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const astDumpToolRenderer = {
	inline: true,
	renderCall(args: AstDumpRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.lang) meta.push(args.lang);
		const description = args.path ?? (args.code ? "inline code" : "?");
		return new Text(renderStatusLine({ icon: "pending", title: "AST Dump", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstDumpToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstDumpRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const details = result.details;
		const description = details?.path ?? args?.path ?? (args?.code ? "inline code" : undefined);
		const meta = [details?.language, details?.hasErrors ? uiTheme.fg("warning", "parse errors") : undefined].filter(
			(value): value is string => Boolean(value),
		);
		const header = renderStatusLine(
			{ icon: details?.hasErrors ? "warning" : "success", title: "AST Dump", description, meta },
			uiTheme,
		);
		const tree = details?.tree ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const treeLines = tree.split("\n");
		const visibleLines = options.expanded ? treeLines : treeLines.slice(0, COLLAPSED_TREE_LINES);
		const truncated = !options.expanded && treeLines.length > visibleLines.length;
		return new Text(
			[
				header,
				...visibleLines.map(line => uiTheme.fg("toolOutput", truncateToWidth(line, 160, Ellipsis.Omit))),
				truncated ? uiTheme.fg("dim", "…") : undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
			0,
			0,
		);
	},
	mergeCallAndResult: true,
};

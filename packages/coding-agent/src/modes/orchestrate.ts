import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

const ORCHESTRATE_WORD = /(?<!\S)orchestrate(?!\S)/;

export const ORCHESTRATE_NOTICE: string = orchestrateNotice.trim();

export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}

export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter({
	probe: /orchestrate/,
	highlight: /(?<!\S)orchestrate(?!\S)/g,
	stops: 14,
	hue: t => 150 + t * 130,
});

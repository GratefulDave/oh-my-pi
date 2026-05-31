import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

const ULTRATHINK_WORD = /(?<!\S)ultrathink(?!\S)/;

export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

export function containsUltrathink(text: string): boolean {
	return keywordInProse(text, ULTRATHINK_WORD);
}

export const highlightUltrathink: KeywordHighlighter = createGradientHighlighter({
	probe: /ultrathink/,
	highlight: /(?<!\S)ultrathink(?!\S)/g,
	stops: 14,
	hue: t => t * 330,
});

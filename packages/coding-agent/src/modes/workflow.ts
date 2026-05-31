import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

const WORKFLOW_WORD = /(?<!\S)workflows?(?!\S)/;

export const WORKFLOW_NOTICE: string = workflowNotice.trim();

export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflow/,
	highlight: /(?<!\S)workflows?(?!\S)/g,
	stops: 14,
	hue: t => 30 + t * 120,
});

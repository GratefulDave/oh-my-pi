import { highlightOrchestrate } from "./orchestrate";
import { highlightUltrathink } from "./ultrathink";
import { highlightWorkflow } from "./workflow";

export function highlightMagicKeywords(text: string, resetTo?: string): string {
	return highlightWorkflow(highlightOrchestrate(highlightUltrathink(text, resetTo), resetTo), resetTo);
}

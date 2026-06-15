
interface SemanticSearchMessage {
	content: string;
	customType: string;
}

interface RendererTheme {
	bg(name: string, text: string): string;
	fg(name: string, text: string): string;
	bold(text: string): string;
}

export function renderSemanticSearchMessage(
	message: SemanticSearchMessage,
	options: { expanded: boolean },
	theme: RendererTheme,
): { render(width: number): string[] } {
	const lines = message.content.split(/\r?\n/);
	const visibleLines = options.expanded ? lines : lines.slice(0, 4);
	const remaining = options.expanded ? 0 : Math.max(0, lines.length - visibleLines.length);
	return {
		render(): string[] {
			const rendered = [theme.fg("customMessageLabel", theme.bold("[semantic-search-results]"))];
			if (visibleLines.length > 0) {
				rendered.push("");
				rendered.push(...visibleLines.map(line => theme.fg("customMessageText", line)));
			}
			if (remaining > 0) {
				rendered.push("");
				rendered.push(theme.fg("dim", `… ${remaining} more lines (ctrl+o to expand)`));
			}
			return rendered;
		},
	};
}

import { Box, Spacer, Text } from "@oh-my-pi/pi-tui";

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
): Box {
	const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[semantic-search-results]")), 0, 0));
	box.addChild(new Spacer(1));
	const lines = message.content.split(/\r?\n/);
	if (options.expanded) {
		box.addChild(new Text(theme.fg("customMessageText", lines.join("\n")), 0, 0));
		return box;
	}
	const summary = lines.slice(0, 4).join("\n");
	const remaining = Math.max(0, lines.length - 4);
	box.addChild(new Text(theme.fg("customMessageText", summary), 0, 0));
	if (remaining > 0) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("dim", `… ${remaining} more lines (ctrl+o to expand)`), 0, 0));
	}
	return box;
}

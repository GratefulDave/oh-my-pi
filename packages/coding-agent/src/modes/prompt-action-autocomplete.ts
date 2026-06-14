import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	getKeybindings,
	type SlashCommand,
} from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { formatKeyHints, type KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import { applyEmojiCompletion, getEmojiSuggestions, isEmojiPrefix, tryEmojiInlineReplace } from "./emoji-autocomplete";
import {
	applyInternalUrlCompletion,
	getInternalUrlSuggestions,
	isInternalUrlPrefix,
} from "./internal-url-autocomplete";

interface PromptActionDefinition {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	execute: (prefix: string) => void;
}

interface PromptActionAutocompleteItem extends AutocompleteItem {
	actionId: string;
	execute: (prefix: string) => void;
}
interface PromptHistoryEntry {
	prompt: string;
	cwd?: string;
}

interface PromptHistoryStorage {
	search(query: string, limit: number, cwd?: string): PromptHistoryEntry[];
}

interface PromptHistoryAutocompleteItem extends AutocompleteItem {
	historyPrompt: string;
}

interface PromptActionAutocompleteOptions {
	commands: SlashCommand[];
	basePath: string;
	keybindings: KeybindingsManager;
	historyStorage?: PromptHistoryStorage;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let queryIndex = 0;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			queryIndex += 1;
		}
	}

	return queryIndex === query.length;
}

function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	let queryIndex = 0;
	let gaps = 0;
	let lastMatchIndex = -1;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			if (lastMatchIndex >= 0 && targetIndex - lastMatchIndex > 1) {
				gaps += 1;
			}
			lastMatchIndex = targetIndex;
			queryIndex += 1;
		}
	}

	if (queryIndex !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
}

function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
}
function isPromptHistoryItem(item: AutocompleteItem): item is PromptHistoryAutocompleteItem {
	return "historyPrompt" in item && typeof (item as PromptHistoryAutocompleteItem).historyPrompt === "string";
}

function promptHistoryQuery(lines: string[], cursorLine: number, cursorCol: number): string | null {
	if (cursorLine !== lines.length - 1) return null;
	const currentLine = lines[cursorLine] || "";
	if (cursorCol !== currentLine.length) return null;
	const text = lines.join("\n").trimStart();
	const query = text.trim();
	if (query.length < 2) return null;
	if (query.startsWith("/") || query.startsWith("#") || query.startsWith("@")) return null;
	return query;
}

function promptHistoryItems(entries: PromptHistoryEntry[], query: string): AutocompleteItem[] {
	const seen = new Set<string>();
	const lowerQuery = query.toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const entry of entries) {
		const prompt = entry.prompt.trim();
		if (!prompt || prompt === query || seen.has(prompt)) continue;
		seen.add(prompt);
		const lowerPrompt = prompt.toLowerCase();
		if (!lowerPrompt.includes(lowerQuery) && !fuzzyMatch(lowerQuery, lowerPrompt)) continue;
		const hint = lowerPrompt.startsWith(lowerQuery) ? prompt.slice(query.length) : undefined;
		const item: PromptHistoryAutocompleteItem = {
			value: prompt,
			label: prompt.split("\n", 1)[0] || prompt,
			description: entry.cwd ? `history · ${entry.cwd}` : "history",
			hint,
			historyPrompt: prompt,
		};
		items.push(item);
	}
	return items;
}

function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;

	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(hashIndex);
}

export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	#baseProvider: CombinedAutocompleteProvider;
	#actions: PromptActionDefinition[];
	#historyStorage?: PromptHistoryStorage;

	constructor(
		commands: SlashCommand[],
		basePath: string,
		actions: PromptActionDefinition[],
		historyStorage?: PromptHistoryStorage,
	) {
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath);
		this.#actions = actions;
		this.#historyStorage = historyStorage;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const promptActionPrefix = getPromptActionPrefix(textBeforeCursor);
		if (promptActionPrefix) {
			const query = promptActionPrefix.slice(1).toLowerCase();
			const items = this.#actions
				.map(action => {
					const searchable = [action.label, action.description, ...action.keywords].join(" ").toLowerCase();
					if (!fuzzyMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: fuzzyScore(query, searchable),
					} satisfies PromptActionAutocompleteItem & { score: number };
				})
				.filter(item => item !== null)
				.sort((a, b) => b.score - a.score)
				.map(({ score: _score, ...item }) => item);
			if (items.length > 0) {
				return { items, prefix: promptActionPrefix };
			}
		}

		const urlSuggestions = await getInternalUrlSuggestions(textBeforeCursor);
		if (urlSuggestions) return urlSuggestions;

		if (!isSettingsInitialized() || settings.get("emojiAutocomplete")) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		const baseSuggestions = await this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol);
		if (baseSuggestions) return baseSuggestions;

		const query = promptHistoryQuery(lines, cursorLine, cursorCol);
		if (!query || !this.#historyStorage) return null;
		const items = promptHistoryItems(this.#historyStorage.search(query, 8, getProjectDir()), query);
		return items.length > 0 ? { items, prefix: query } : null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	} {
		if (isPromptHistoryItem(item)) {
			const newLines = item.historyPrompt.split("\n");
			const lastLine = newLines[newLines.length - 1] ?? "";
			return {
				lines: newLines,
				cursorLine: newLines.length - 1,
				cursorCol: lastLine.length,
			};
		}

		if (prefix.startsWith("#") && isPromptActionItem(item)) {
			if (item.actionId === "undo") {
				return {
					lines,
					cursorLine,
					cursorCol,
					onApplied: () => item.execute(prefix),
				};
			}
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length,
				onApplied: () => item.execute(prefix),
			};
		}

		if (isInternalUrlPrefix(prefix)) {
			return applyInternalUrlCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		if (isEmojiPrefix(prefix)) {
			return applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		return this.#baseProvider.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		return this.#baseProvider.trySyncSlashCompletion?.(textBeforeCursor) ?? null;
	}
	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		if (isSettingsInitialized() && !settings.get("emojiAutocomplete")) return null;
		return tryEmojiInlineReplace(textBeforeCursor);
	}
}

export function createPromptActionAutocompleteProvider(
	options: PromptActionAutocompleteOptions,
): PromptActionAutocompleteProvider {
	const editorKeybindings = getKeybindings();
	const actions: PromptActionDefinition[] = [
		{
			id: "copy-line",
			label: "Copy current line",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyLine")),
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyPrompt")),
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "undo",
			label: "Undo",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.undo")),
			keywords: ["undo", "revert", "edit", "history"],
			execute: options.undo,
		},
		{
			id: "cursor-message-end",
			label: "Move cursor to end of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "end", "prompt", "last", "bottom"],
			execute: options.moveCursorToMessageEnd,
		},
		{
			id: "cursor-message-start",
			label: "Move cursor to beginning of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "start", "beginning", "prompt", "first", "top"],
			execute: options.moveCursorToMessageStart,
		},
		{
			id: "cursor-line-start",
			label: "Move cursor to beginning of line",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineStart")),
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to end of line",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineEnd")),
			keywords: ["move", "cursor", "line", "end"],
			execute: options.moveCursorToLineEnd,
		},
	];

	return new PromptActionAutocompleteProvider(options.commands, options.basePath, actions, options.historyStorage);
}

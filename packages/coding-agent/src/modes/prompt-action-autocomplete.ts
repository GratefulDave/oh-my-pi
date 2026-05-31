import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	getKeybindings,
	type SlashCommand,
} from "@oh-my-pi/pi-tui";
import { formatKeyHints, type KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { applyEmojiCompletion, getEmojiSuggestions, isEmojiPrefix, tryEmojiInlineReplace } from "./emoji-autocomplete";

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

interface PromptActionAutocompleteOptions {
	commands: SlashCommand[];
	basePath: string;
	keybindings: KeybindingsManager;
	session?: AgentSession;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

function getInternalUrlPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(
		/(?:skill:\/\/|rule:\/\/|agent:\/\/|artifact:\/\/|local:\/\/|memory:\/\/|omp:\/\/)[^\s]*$/i,
	);
	if (match) {
		return match[0];
	}

	const schemes = ["skill://", "rule://", "agent://", "artifact://", "local://", "memory://", "omp://"];
	const words = textBeforeCursor.split(/[\s"']/);
	const lastWord = words[words.length - 1];
	if (lastWord && lastWord.length > 0) {
		for (const scheme of schemes) {
			if (scheme.startsWith(lastWord.toLowerCase()) && lastWord.toLowerCase() !== scheme) {
				return lastWord;
			}
		}
	}

	return null;
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
	#session: AgentSession | undefined;

	constructor(commands: SlashCommand[], basePath: string, actions: PromptActionDefinition[], session?: AgentSession) {
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath);
		this.#actions = actions;
		this.#session = session;
	}

	async #getInternalUrlSuggestions(prefix: string): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (!this.#session) {
			return null;
		}

		const schemes = ["skill://", "rule://", "agent://", "artifact://", "local://", "memory://", "omp://"];

		if (!prefix.includes("://")) {
			const query = prefix.toLowerCase();
			const items = schemes
				.filter(s => s.startsWith(query))
				.map(s => ({
					value: s,
					label: s,
					description: `Internal URL scheme: ${s}`,
				}));
			return { items, prefix };
		}

		const colonSlashIndex = prefix.indexOf("://");
		const scheme = prefix.slice(0, colonSlashIndex + 3).toLowerCase();
		const query = prefix.slice(colonSlashIndex + 3).toLowerCase();

		let candidates: Array<{ value: string; label: string; description?: string }> = [];

		if (scheme === "local://") {
			try {
				const artifactsDir = this.#session.sessionManager.getArtifactsDir();
				const sessionId = this.#session.sessionId;
				const { resolveLocalRoot, listFilesRecursively } = require("../internal-urls/local-protocol");
				const rootPath = resolveLocalRoot({
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => sessionId,
				});

				const files = await listFilesRecursively(rootPath);
				candidates = files.map((file: string) => ({
					value: `local://${file}`,
					label: `local://${file}`,
					description: "Local artifact file",
				}));
			} catch {}
		} else if (scheme === "skill://") {
			try {
				const cwd = this.#session.sessionManager.getCwd();
				const skillsDir = path.join(cwd, ".omp", "skills");
				const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
				const skillNames = entries.filter(e => e.isDirectory() || e.isFile()).map(e => e.name.replace(/\.md$/, ""));
				candidates = skillNames.map(name => ({
					value: `skill://${name}`,
					label: `skill://${name}`,
					description: `Skill: ${name}`,
				}));
			} catch {}
		} else if (scheme === "rule://") {
			try {
				const cwd = this.#session.sessionManager.getCwd();
				const rulesDir = path.join(cwd, ".omp", "rules");
				const entries = await fs.promises.readdir(rulesDir, { withFileTypes: true }).catch(() => []);
				const ruleNames = entries.filter(e => e.isFile()).map(e => e.name.replace(/\.md$/, ""));
				candidates = ruleNames.map(name => ({
					value: `rule://${name}`,
					label: `rule://${name}`,
					description: `Rule: ${name}`,
				}));
			} catch {}
		} else if (scheme === "agent://") {
			candidates = [{ value: "agent://0-Main", label: "agent://0-Main", description: "Main agent session" }];
		} else if (scheme === "omp://") {
			candidates = [{ value: "omp://docs", label: "omp://docs", description: "OMP developer documentation" }];
		} else if (scheme === "memory://") {
			candidates = [{ value: "memory://root", label: "memory://root", description: "Project memory summary" }];
		}

		if (candidates.length === 0) {
			return null;
		}

		const items = candidates
			.map(c => {
				const searchable = c.value.toLowerCase();
				if (!fuzzyMatch(query, searchable.slice(scheme.length))) return null;
				return {
					...c,
					score: fuzzyScore(query, searchable.slice(scheme.length)),
				};
			})
			.filter((item): item is typeof item & { score: number } => item !== null)
			.sort((a, b) => b.score - a.score)
			.map(({ score, ...item }) => item);

		return { items, prefix };
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const internalUrlPrefix = getInternalUrlPrefix(textBeforeCursor);
		if (internalUrlPrefix) {
			const suggestions = await this.#getInternalUrlSuggestions(internalUrlPrefix);
			if (suggestions && suggestions.items.length > 0) {
				return suggestions;
			}
		}
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

		if (!isSettingsInitialized() || settings.get("emojiAutocomplete")) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol);
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
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const internalUrlPrefix = getInternalUrlPrefix(textBeforeCursor);
		if (internalUrlPrefix) {
			const beforePrefix = currentLine.slice(0, cursorCol - internalUrlPrefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + item.value + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
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

	return new PromptActionAutocompleteProvider(options.commands, options.basePath, actions, options.session);
}

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { KeybindingsManager as AppKeybindingsManager } from "../src/config/keybindings";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";
import type { AgentSession } from "../src/session/agent-session";

describe("Internal URL Autocomplete", () => {
	beforeEach(() => {
		setKeybindings(
			new KeybindingsManager({
				"tui.editor.cursorLineStart": { defaultKeys: ["home", "f6"], description: "Move cursor to line start" },
				"tui.editor.cursorLineEnd": { defaultKeys: "f7", description: "Move cursor to line end" },
				"tui.editor.undo": { defaultKeys: "f8", description: "Undo" },
			}),
		);
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("suggests schemes when typing scheme name", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/workspace",
			keybindings: AppKeybindingsManager.inMemory({
				"app.clipboard.copyLine": "ctrl+shift+l",
				"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
			}),
			session: {} as any as AgentSession,
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const result = await provider.getSuggestions(["skil"], 0, 4);
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("skil");
		expect(result!.items.some(item => item.value === "skill://")).toBe(true);
	});

	it("suggests static schemes like agent:// and omp://", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/workspace",
			keybindings: AppKeybindingsManager.inMemory({
				"app.clipboard.copyLine": "ctrl+shift+l",
				"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
			}),
			session: {} as any as AgentSession,
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const result = await provider.getSuggestions(["omp://d"], 0, 7);
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("omp://d");
		expect(result!.items.some(item => item.value === "omp://docs")).toBe(true);
	});
});

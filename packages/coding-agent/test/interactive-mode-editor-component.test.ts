import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { EditorTheme, TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

class TestModalEditor extends CustomEditor {}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("exposes the configured editor factory for extension composition", () => {
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		const factory = (_tui: TUI, editorTheme: EditorTheme) => new TestModalEditor(editorTheme);

		expect(mode.getEditorComponent()).toBeUndefined();
		mode.setEditorComponent(factory);
		expect(mode.getEditorComponent()).toBe(factory);

		mode.setEditorComponent(undefined);
		expect(mode.getEditorComponent()).toBeUndefined();
		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});

	it("keeps extension Space-hold listeners bound after replacing the editor", async () => {
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		await mode.initHooksAndCustomTools();
		const ui = mode.getToolUIContext();
		if (!ui) throw new Error("Extension UI context was not initialized");
		const onStart = vi.fn();
		const unsubscribe = ui.onSpaceHold({ onStart, onEnd: vi.fn() });

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		mode.editor.onSpaceHoldStart?.();

		expect(onStart).toHaveBeenCalledTimes(1);
		unsubscribe();
		expect(refreshSpy).toHaveBeenCalled();
	});
});

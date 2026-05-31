import { beforeAll, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { TUI } from "@oh-my-pi/pi-tui";

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load dark theme");
	setThemeInstance(testTheme);
}

describe("SelectorController model picker persistence", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme");
	});

	it("flushes settings immediately when picker sets default model", async () => {
		installTestTheme();
		const model = getBundledModel("openai-codex", "gpt-5.5");
		if (!model) throw new Error("Expected bundled model openai-codex/gpt-5.5");

		const settings = Settings.isolated({});
		const flushSpy = vi.spyOn(settings, "flush").mockResolvedValue();
		const setModel = vi.fn(async () => undefined);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const editorContainer = {
			children: [] as unknown[],
			clear() {
				this.children = [];
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		const ui = {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			terminal: { columns: 120 },
		} as unknown as TUI;
		const modelRegistry = {
			refresh: vi.fn(async () => undefined),
			getAvailable: () => [model],
			getAll: () => [model],
			getDiscoverableProviders: () => [],
			getCanonicalModels: () => [],
			resolveCanonicalModel: () => undefined,
			getError: () => undefined,
			getProviderDiscoveryState: () => undefined,
		} as unknown as ModelRegistry;
		const ctx = {
			ui,
			editor: {},
			editorContainer,
			settings,
			session: {
				model,
				modelRegistry,
				scopedModels: [],
				setModel,
				setModelTemporary: vi.fn(async () => undefined),
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus,
			showError,
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);
		controller.showModelSelector();
		const selector = editorContainer.children[0];
		if (!(selector instanceof ModelSelectorComponent)) {
			throw new Error("Expected model selector component");
		}
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(setModel).toHaveBeenCalledWith(model, "default", {
			selector: `${model.provider}/${model.id}`,
			thinkingLevel: "inherit",
		});
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(`Default model: ${model.provider}/${model.id}`);
		expect(showError).not.toHaveBeenCalled();
	});
});

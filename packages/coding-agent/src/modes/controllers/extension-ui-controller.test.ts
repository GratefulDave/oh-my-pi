import { describe, expect, it, vi } from "bun:test";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	const addAutocompleteProvider = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
		},
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
	} as unknown as InteractiveModeContext;

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		async init(): Promise<ExtensionUIContext> {
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});

	it("routes prompt Space holds to extensions and restores prior handlers", async () => {
		const harness = makeHarness();
		const previousStart = vi.fn();
		const previousEnd = vi.fn();
		harness.editor.sttHoldEnabled = () => false;
		harness.editor.onSpaceHoldStart = previousStart;
		harness.editor.onSpaceHoldEnd = previousEnd;
		const ui = await harness.init();
		const firstStart = vi.fn();
		const secondStart = vi.fn();
		const secondEnd = vi.fn();
		const unsubscribeFirst = ui.onSpaceHold({ onStart: firstStart, onEnd: vi.fn() });
		const unsubscribeSecond = ui.onSpaceHold({ onStart: secondStart, onEnd: secondEnd });

		expect(harness.editor.sttHoldEnabled()).toBe(true);
		harness.editor.onSpaceHoldStart?.();
		harness.editor.onSpaceHoldEnd?.();
		expect(firstStart).toHaveBeenCalledTimes(1);
		expect(secondStart).toHaveBeenCalledTimes(1);
		expect(secondEnd).toHaveBeenCalledTimes(1);
		expect(previousStart).not.toHaveBeenCalled();
		expect(previousEnd).not.toHaveBeenCalled();

		unsubscribeFirst();
		harness.editor.onSpaceHoldStart?.();
		expect(firstStart).toHaveBeenCalledTimes(1);
		expect(secondStart).toHaveBeenCalledTimes(2);

		unsubscribeSecond();
		expect(harness.editor.sttHoldEnabled()).toBe(false);
		harness.editor.onSpaceHoldStart?.();
		harness.editor.onSpaceHoldEnd?.();
		expect(previousStart).toHaveBeenCalledTimes(1);
		expect(previousEnd).toHaveBeenCalledTimes(1);
	});
});

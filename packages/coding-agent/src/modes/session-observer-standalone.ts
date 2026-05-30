/**
 * Standalone read-only session observer mode.
 *
 * Launched via `lex --observe-session <session-file>` in a mux window.
 * Creates a full-screen TUI that displays the target session transcript
 * and periodically refreshes it. Esc or Ctrl+S closes the process.
 */
import type { KeyId } from "@oh-my-pi/pi-tui";
import { Container, ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { SessionObserverOverlayComponent } from "./components/session-observer-overlay";
import { SessionObserverRegistry } from "./session-observer-registry";
import { initTheme, stopThemeWatcher } from "./theme/theme";

/** Refresh interval for transcript polling (ms). */
const REFRESH_INTERVAL_MS = 1000;

/**
 * Run a full-screen read-only observer TUI for the given session file.
 *
 * Returns when the user closes the overlay (Esc or Ctrl+S).
 * Never creates model sessions, never prompts the model.
 */
export async function runStandaloneSessionObserver(sessionFile: string): Promise<void> {
	await initTheme(true /* enableWatcher */);

	const registry = new SessionObserverRegistry();
	registry.registerStandaloneSession(sessionFile);

	const ui = new TUI(new ProcessTerminal(), false);

	const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<void>();

	const onDone = (): void => {
		resolveDone();
	};

	// Mirror the in-TUI observer's close keys: Esc is handled natively by the
	// component; Ctrl+S matches app.session.observe default binding.
	const observeKeys: KeyId[] = ["ctrl+s" as KeyId];

	const overlay = new SessionObserverOverlayComponent(registry, onDone, observeKeys);

	// The overlay component is the sole content of the TUI.
	const root = new Container();
	root.addChild(overlay);
	ui.addChild(root);
	ui.setFocus(overlay);

	ui.start();
	ui.requestRender(true);

	const refreshTimer = setInterval(() => {
		overlay.refreshFromRegistry();
		ui.requestRender();
	}, REFRESH_INTERVAL_MS);

	await donePromise;

	clearInterval(refreshTimer);
	ui.stop();
	registry.dispose();
	stopThemeWatcher();
}

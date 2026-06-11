// Comprehensive stub for @oh-my-pi/pi-natives — prevents native addon load
// failures when pi-tui is bundled into extension bundles.
export const Ellipsis = { None: 0, Head: 1, Middle: 2, Tail: 3 };
export const KeyEventType = { Press: 0, Release: 1, Repeat: 2 };
export const ProcessStatus = { Running: 0, Exited: 1, Signaled: 2 };
export const FileType = { File: 0, Dir: 1, Symlink: 2 };
export const Process = class {};
export function fuzzyFind() { return Promise.resolve({ matches: [] }); }
export function matchesKey() { return false; }
export function parseKey() { return null; }
export function parseKittySequence() { return null; }
export function encodeSixel() { return ""; }
export function copyToClipboard() {}
export function truncateToWidth(text) { return text; }
export function visibleWidth(text) { return text.length; }
export function sliceWithWidth(text) { return { text, width: text.length }; }
export function extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth) {
	return { before: line.slice(0, beforeEnd), after: line.slice(afterStart), beforeWidth: beforeEnd, afterWidth: line.length - afterStart };
}
export function wrapTextWithAnsi(text, width, tabWidth) { return [text]; }

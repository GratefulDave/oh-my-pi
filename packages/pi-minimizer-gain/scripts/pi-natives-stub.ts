// Stub for @oh-my-pi/pi-natives — provides no-op implementations for
// exports used transitively by @oh-my-pi/pi-tui when bundled into
// extension bundles. Prevents native addon load failures.

// Enums (must be plain objects matching napi-rs string_enum pattern)
export const Ellipsis = { None: 0, Head: 1, Middle: 2, Tail: 3 } as const;
export const KeyEventType = { Press: 0, Release: 1, Repeat: 2 } as const;
export const ProcessStatus = { Running: 0, Exited: 1, Signaled: 2 } as const;
export const FileType = { File: 0, Dir: 1, Symlink: 2 } as const;

// Types (empty at runtime)
export type SliceResult = { text: string; width: number };

// Classes (minimal stubs for types used as values)
export const Process = class {} as unknown as { new (...args: any[]): any };

// Functions
export function fuzzyFind(_options: any): Promise<any> {
	return Promise.resolve({ matches: [] });
}

export function matchesKey(_data: string, _keyId: string, _kittyProtocolActive: boolean): boolean {
	return false;
}

export function parseKey(_data: string, _kittyProtocolActive: boolean): string | null {
	return null;
}

export function parseKittySequence(_data: string): any {
	return null;
}

export function encodeSixel(_bytes: Uint8Array, _targetWidthPx: number, _targetHeightPx: number): string {
	return "";
}

export function copyToClipboard(_text: string): void {}

export function truncateToWidth(
	_text: string,
	_maxWidth: number,
	_ellipsisKind: any,
	_pad: boolean,
	_tabWidth: number,
): string {}

export function visibleWidth(text: string, _tabWidth: number): number {
	return text.length;
}

export function replaceTabs(text: string, _tabWidth: number): string {
	return text.replace(/\t/g, "    ");
}

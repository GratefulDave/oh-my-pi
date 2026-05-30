/**
 * Inlined formatting utilities — zero external dependencies.
 *
 * Copied from @oh-my-pi/pi-utils/src/format.ts to avoid runtime
 * @oh-my-pi/* imports that fail in compiled binary context.
 */

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: "123ms", "1.5s", "30m15s", "2h30m", "3d2h"
 */
export function formatDuration(ms: number): string {
	if (ms < SEC) return `${ms}ms`;
	if (ms < MIN) return `${(ms / SEC).toFixed(1)}s`;
	if (ms < HOUR) {
		const mins = Math.floor(ms / MIN);
		const secs = Math.floor((ms % MIN) / SEC);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const mins = Math.floor((ms % HOUR) / MIN);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 * For display-width-aware truncation (terminals), use truncateToWidth from @oh-my-pi/pi-tui.
 */
export function truncate(str: string, maxLen: number, ellipsis = "…"): string {
	if (str.length <= maxLen) return str;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${str.slice(0, sliceLen)}${ellipsis}`;
}

import { maskNonProse } from "./markdown-prose";
import { theme } from "./theme/theme";

export type KeywordHighlighter = (text: string, resetTo?: string) => string;

const FG_RESET = "\x1b[39m";

export interface GradientHighlightSpec {
	probe: RegExp;
	highlight: RegExp;
	stops: number;
	hue: (t: number) => number;
	saturation?: number;
	lightness?: number;
}

export function createGradientHighlighter(spec: GradientHighlightSpec): KeywordHighlighter {
	const { probe, highlight, stops, hue, saturation = 90, lightness = 62 } = spec;

	let cachedMode: string | undefined;
	let cachedPalette: readonly string[] | undefined;

	const palette = (): readonly string[] => {
		const mode = theme.getColorMode();
		if (cachedPalette && cachedMode === mode) return cachedPalette;
		const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
		const next: string[] = [];
		for (let i = 0; i < stops; i++) {
			next.push(Bun.color(`hsl(${Math.round(hue(i / stops))}, ${saturation}%, ${lightness}%)`, format) ?? "");
		}
		cachedMode = mode;
		cachedPalette = next;
		return next;
	};

	const paint = (word: string, resetTo: string): string => {
		const stopsArr = palette();
		const n = word.length;
		let out = "";
		let prev = "";
		for (let i = 0; i < n; i++) {
			const color = stopsArr[Math.floor((i / n) * stopsArr.length)] ?? stopsArr[0] ?? "";
			if (color !== prev) {
				out += color;
				prev = color;
			}
			out += word[i];
		}
		return `${out}${resetTo}`;
	};

	return (text: string, resetTo: string = FG_RESET): string => {
		if (!probe.test(text)) return text;
		const masked = maskNonProse(text);
		let out = "";
		let last = 0;
		for (const m of masked.matchAll(highlight)) {
			const start = m.index ?? 0;
			const end = start + m[0].length;
			out += text.slice(last, start) + paint(text.slice(start, end), resetTo);
			last = end;
		}
		return out + text.slice(last);
	};
}

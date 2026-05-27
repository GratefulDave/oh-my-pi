import { prompt } from "@oh-my-pi/pi-utils";
import type { HelperOptions } from "@oh-my-pi/pi-utils/prompt";
import { formatNumberedLine } from "@oh-my-pi/hashline";

interface HashlinePromptState {
	refs: Map<number, string>;
	lastRef?: string;
}

const states = new WeakMap<object, HashlinePromptState>();

function isHelperOptions(value: unknown): value is HelperOptions {
	return typeof value === "object" && value !== null && "hash" in value;
}

function splitHelperArgs(args: unknown[]): { positional: unknown[]; options: HelperOptions } {
	const maybeOptions = args.at(-1);
	if (!isHelperOptions(maybeOptions)) {
		throw new Error("hashline prompt helper called without Handlebars options");
	}
	return { positional: args.slice(0, -1), options: maybeOptions };
}

function getStateKey(thisArg: unknown, options: HelperOptions): object {
	const data = options.data as { root?: unknown } | undefined;
	if (typeof data?.root === "object" && data.root !== null) return data.root;
	if (typeof thisArg === "object" && thisArg !== null) return thisArg;
	return options;
}

function getHashlineHelperState(thisArg: unknown, options: HelperOptions): HashlinePromptState {
	const key = getStateKey(thisArg, options);
	let state = states.get(key);
	if (!state) {
		state = { refs: new Map() };
		states.set(key, state);
	}
	return state;
}

function parseLineNumber(value: unknown): number {
	const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isInteger(num) || num < 1) {
		throw new Error(`hashline prompt helper expected a positive line number, got ${String(value)}`);
	}
	return num;
}

function formatHashlineRef(lineNum: unknown, content: unknown): { num: number; ref: string; text: string } {
	const num = parseLineNumber(lineNum);
	return { num, ref: String(num), text: content == null ? "" : String(content) };
}

function rememberHashlineRef(state: HashlinePromptState, num: number, ref: string): void {
	state.refs.set(num, ref);
	state.lastRef = ref;
}

function resolveHashlineRef(thisArg: unknown, args: unknown[]): string {
	const { positional, options } = splitHelperArgs(args);
	const [lineNum, content] = positional;
	const state = getHashlineHelperState(thisArg, options);
	if (lineNum === undefined) {
		if (state.lastRef) return state.lastRef;
		throw new Error("{{hrefr}} requires a line number or a previous {{hline}} in the same prompt render");
	}

	const { num, ref } = formatHashlineRef(lineNum, content);
	return state.refs.get(num) ?? ref;
}

prompt.registerHelper("hline", function (this: unknown, ...args: unknown[]): string {
	const { positional, options } = splitHelperArgs(args);
	const [lineNum, content] = positional;
	const { num, ref, text } = formatHashlineRef(lineNum, content);
	const state = getHashlineHelperState(this, options);
	rememberHashlineRef(state, num, ref);
	return formatNumberedLine(num, text);
});

prompt.registerHelper("hrefr", function (this: unknown, ...args: unknown[]): string {
	return resolveHashlineRef(this, args);
});

prompt.registerHelper("href", function (this: unknown, ...args: unknown[]): string {
	return JSON.stringify(resolveHashlineRef(this, args));
});

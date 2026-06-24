declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.jl" {
	const content: string;
	export default content;
}

declare module "*.rb" {
	const content: string;
	export default content;
}

declare module "*.js" {
	const content: string;
	export default content;
}

interface HTMLElementTagNameMap {
	strike: HTMLElement;
}

declare var MessageEvent: {
	new <T>(type: string, eventInitDict?: MessageEventInit<T>): MessageEvent<T>;
	prototype: MessageEvent<unknown>;
	data?: unknown;
};

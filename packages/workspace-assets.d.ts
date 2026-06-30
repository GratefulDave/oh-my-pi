declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*.html" {
	const content: string;
	export default content;
}

declare module "*.lark" {
	const content: string;
	export default content;
}

declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.py" {
	const content: string;
	export default content;
}

declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";

	export const gfm: TurndownService.Plugin;
}

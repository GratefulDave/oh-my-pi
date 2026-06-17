declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*.lark" {
	const content: string;
	export default content;
}

declare module "*.py" {
	const content: string;
	export default content;
}

declare module "./template.js" {
	const content: string;
	export default content;
}

declare module "./tool-views.generated.js" {
	const content: string;
	export default content;
}

declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";

	export const gfm: TurndownService.Plugin;
}

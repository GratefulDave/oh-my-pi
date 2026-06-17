import Handlebars from "handlebars";

export function renderFactoryTemplate(template: string, data: Record<string, unknown>): string {
	return Handlebars.compile(template, { noEscape: true })(data);
}

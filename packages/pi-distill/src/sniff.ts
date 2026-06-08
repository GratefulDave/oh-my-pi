import * as YAML from "yaml";

export type StructuredKind = "json" | "yaml";

export interface StructuredPayload {
	kind: StructuredKind;
	data: unknown;
	stringify: (value: unknown) => string;
}

const FENCE_PATTERN = /^\s*```(?:\s*(json|ya?ml))?\s*\n([\s\S]*?)\n```\s*$/i;

export function parseStructured(text: string): StructuredPayload | null {
	const fenced = FENCE_PATTERN.exec(text);
	const body = fenced ? fenced[2] : text;
	const fenceKind = fenced?.[1]?.toLowerCase();
	const trimmed = body.trimStart();

	if (fenceKind === "json" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return {
				kind: "json",
				data: JSON.parse(body),
				stringify: value => JSON.stringify(value, null, 2),
			};
		} catch {
			if (fenceKind === "json") return null;
		}
	}

	if (fenceKind === "yaml" || fenceKind === "yml" || /^---\s*$/m.test(body) || /^[\w.-]+:\s/m.test(trimmed)) {
		try {
			const data = YAML.parse(body);
			if (data && typeof data === "object") {
				return { kind: "yaml", data, stringify: value => YAML.stringify(value) };
			}
		} catch {}
	}

	return null;
}

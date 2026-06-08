/**
 * Content-type sniffing for tool output. JSON is detected and parsed with zero
 * dependencies; YAML is best-effort via the optional `yaml` dependency (absent →
 * YAML is silently skipped, JSON still works).
 *
 * Each parse returns a bound `stringify` so the compressor re-serializes with the
 * matching format without knowing which one it is.
 */

export interface Parsed {
	kind: "json" | "yaml";
	data: unknown;
	stringify: (value: unknown) => string;
}

// Lazy, cached YAML module load. `null` once we know it is unavailable.
let yamlMod: { parse: (s: string) => unknown; stringify: (v: unknown) => string } | null | undefined;

async function loadYaml() {
	if (yamlMod === undefined) {
		try {
			yamlMod = (await import("yaml")) as typeof yamlMod;
		} catch {
			yamlMod = null;
		}
	}
	return yamlMod;
}

export async function parseStructured(text: string): Promise<Parsed | null> {
	const trimmed = text.trimStart();

	// JSON: cheap prefix gate, then strict parse.
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return {
				kind: "json",
				data: JSON.parse(text),
				stringify: value => JSON.stringify(value, null, 2),
			};
		} catch {
			/* not valid JSON — fall through */
		}
	}

	// YAML: document marker or a top-level `key: value` line. Requires `yaml`.
	if (/^---\s*$/m.test(text) || /^[\w.-]+:\s/m.test(trimmed)) {
		const yaml = await loadYaml();
		if (yaml) {
			try {
				const data = yaml.parse(text);
				// Guard: a bare scalar/string is not worth treating as structured.
				if (data && typeof data === "object") {
					return { kind: "yaml", data, stringify: value => yaml.stringify(value) };
				}
			} catch {
				/* unparseable YAML — skip */
			}
		}
	}

	return null;
}

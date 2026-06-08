/**
 * Pure structural compressor — no Pi/IO dependencies, node/bun-testable in isolation.
 *
 * Shrinks parsed JSON/YAML data for an in-context preview:
 *   - arrays longer than head+tail collapse to head + elision marker + tail
 *   - strings longer than scalarMax are truncated with a char tally
 *   - objects are walked recursively, keys preserved (structure stays valid)
 *
 * The compressor is LOSSY by design; the caller is responsible for spilling the
 * full original to an artifact before replacing it, so nothing is unrecoverable.
 */

export interface CompressOpts {
	arrayHead: number;
	arrayTail: number;
	scalarMax: number;
}

export const DEFAULTS = {
	minBytes: 4_096,
	arrayHead: 8,
	arrayTail: 4,
	scalarMax: 240,
} as const;

export interface Trim {
	value: unknown;
	/** count of array elements / scalar chars elided beneath this node */
	elided: number;
}

export function compressNode(node: unknown, opts: CompressOpts): Trim {
	let elided = 0;

	if (typeof node === "string") {
		if (node.length > opts.scalarMax) {
			return {
				value: `${node.slice(0, opts.scalarMax)}…(+${node.length - opts.scalarMax} chars)`,
				elided: 1,
			};
		}
		return { value: node, elided: 0 };
	}

	if (Array.isArray(node)) {
		const out: unknown[] = [];
		const collapses = node.length > opts.arrayHead + opts.arrayTail;
		const head = collapses ? node.slice(0, opts.arrayHead) : node;
		for (const el of head) {
			const t = compressNode(el, opts);
			out.push(t.value);
			elided += t.elided;
		}
		if (collapses) {
			const dropped = node.length - opts.arrayHead - opts.arrayTail;
			out.push(`…(+${dropped} items elided)`);
			elided += dropped;
			for (const el of node.slice(node.length - opts.arrayTail)) {
				const t = compressNode(el, opts);
				out.push(t.value);
				elided += t.elided;
			}
		}
		return { value: out, elided };
	}

	if (node && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(node)) {
			const t = compressNode(v, opts);
			out[k] = t.value;
			elided += t.elided;
		}
		return { value: out, elided };
	}

	return { value: node, elided: 0 };
}

export interface CompressResult {
	body: string;
	saved: number;
	elided: number;
}

/**
 * Compress parsed structured data and re-serialize via `stringify`.
 * Returns null when nothing was elided (no artifact churn for already-tight data)
 * or when the result would not be smaller than the original (`before` bytes).
 */
export function compressData(
	data: unknown,
	stringify: (value: unknown) => string,
	before: number,
	opts: CompressOpts,
): CompressResult | null {
	const { value, elided } = compressNode(data, opts);
	if (elided === 0) return null;

	const body = stringify(value);
	const after = Buffer.byteLength(body, "utf8");
	if (after >= before) return null; // never grow

	return { body, saved: before - after, elided };
}

const textEncoder = new TextEncoder();

export const DEFAULTS = {
	minBytes: 4096,
	arrayHead: 8,
	arrayTail: 4,
	scalarMax: 240,
};

export interface DistillOptions {
	arrayHead: number;
	arrayTail: number;
	scalarMax: number;
}

export interface CompressionMetadata {
	artifact: `artifact://${string}`;
	elided: number;
	originalBytes: number;
	recover?: string;
}

export interface CompressionResult {
	value: unknown;
	elided: number;
}

export function byteLength(text: string): number {
	return textEncoder.encode(text).byteLength;
}

export function compressNode(node: unknown, opts: DistillOptions): CompressionResult {
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
		const shouldCollapse = node.length > opts.arrayHead + opts.arrayTail;
		const head = shouldCollapse ? node.slice(0, opts.arrayHead) : node;
		for (const item of head) {
			const compressed = compressNode(item, opts);
			out.push(compressed.value);
			elided += compressed.elided;
		}
		if (shouldCollapse) {
			const dropped = node.length - opts.arrayHead - opts.arrayTail;
			out.push(`…(+${dropped} items elided)`);
			elided += dropped;
			for (const item of node.slice(node.length - opts.arrayTail)) {
				const compressed = compressNode(item, opts);
				out.push(compressed.value);
				elided += compressed.elided;
			}
		}
		return { value: out, elided };
	}

	if (node && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			const compressed = compressNode(value, opts);
			out[key] = compressed.value;
			elided += compressed.elided;
		}
		return { value: out, elided };
	}

	return { value: node, elided: 0 };
}

export function wrapCompressed(value: unknown, metadata: CompressionMetadata): Record<string, unknown> {
	return {
		__pi_distill: metadata,
		data: value,
	};
}

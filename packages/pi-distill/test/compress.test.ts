/** Standalone fixture test for the pure compressor + sniffer. Run: `bun test`. */
import { expect, test } from "bun:test";

import { DEFAULTS, compressData } from "../src/compress";
import { parseStructured } from "../src/sniff";

const opts = { arrayHead: DEFAULTS.arrayHead, arrayTail: DEFAULTS.arrayTail, scalarMax: DEFAULTS.scalarMax };

async function run(text: string) {
	const before = Buffer.byteLength(text, "utf8");
	const parsed = await parseStructured(text);
	if (!parsed) return null;
	return compressData(parsed.data, parsed.stringify, before, opts);
}

test("large JSON array compresses, stays valid JSON, elides middle", async () => {
	const data = { items: Array.from({ length: 50 }, (_, i) => ({ id: i, note: "x".repeat(10) })), blob: "y".repeat(500) };
	const text = JSON.stringify(data, null, 2);
	const res = await run(text);
	expect(res).not.toBeNull();
	expect(res!.saved).toBeGreaterThan(0);
	expect(res!.elided).toBe(50 - opts.arrayHead - opts.arrayTail + 1); // 38 array items + 1 truncated scalar(blob)
	// body must still parse as valid JSON
	const reparsed = JSON.parse(res!.body) as { items: unknown[] };
	expect(Array.isArray(reparsed.items)).toBe(true);
});

test("long scalar truncates with char tally", async () => {
	const text = JSON.stringify({ s: "z".repeat(1000) });
	const res = await run(text);
	expect(res).not.toBeNull();
	expect(res!.body).toContain("chars)");
});

test("already-small / tight payload passes through (null)", async () => {
	const text = JSON.stringify({ a: 1, b: [1, 2, 3] });
	expect(await run(text)).toBeNull(); // nothing elided
});

test("non-JSON text is not structured (null)", async () => {
	expect(await parseStructured("just some log output\nwith lines")).toBeNull();
});

test("invalid JSON prefix does not throw, returns null", async () => {
	expect(await parseStructured("{ not valid json ]")).toBeNull();
});

test("deeply nested object preserves keys", async () => {
	const data = { a: { b: { c: Array.from({ length: 30 }, (_, i) => i) } } };
	const text = JSON.stringify(data, null, 2);
	const res = await run(text);
	expect(res).not.toBeNull();
	const reparsed = JSON.parse(res!.body) as { a: { b: { c: unknown[] } } };
	expect(reparsed.a.b.c.length).toBe(opts.arrayHead + opts.arrayTail + 1); // head+tail+marker
});

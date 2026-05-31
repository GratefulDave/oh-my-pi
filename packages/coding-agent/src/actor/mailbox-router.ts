const MAX_IRC_REPLY_CHARS = 4_000;
const TOOL_FRAGMENT_PATTERNS = [/```json\s*\{?[\s\S]*?"tool/iu, /<tool[_-]?call[\s\S]*?>/iu, /\btool_call_id\b/iu];

function collapseRepeatedParagraphs(text: string): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const paragraph of text.split(/\n{2,}/)) {
		const normalized = paragraph.trim().replace(/\s+/g, " ");
		if (!normalized) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(paragraph.trim());
	}
	return out.join("\n\n");
}

function stripToolFragments(text: string): string {
	let out = text;
	out = out.replace(/<tool[_-]?call[\s\S]*?<\/tool[_-]?call>/giu, "");
	out = out.replace(/```json\s*\{[\s\S]*?"tool(?:_calls|Call|Name)?"[\s\S]*?```/giu, "");
	out = out.replace(/^.*\btool_call_id\b.*$/gim, "");
	return out;
}

export interface SanitizedIrcReply {
	text: string | null;
	droppedReason?: "empty" | "tool_fragment";
}

export function sanitizeIrcReplyText(value: string | null | undefined): SanitizedIrcReply {
	if (value === null || value === undefined) return { text: null };
	const original = value.trim();
	if (!original) return { text: null, droppedReason: "empty" };
	const hadToolFragment = TOOL_FRAGMENT_PATTERNS.some(pattern => pattern.test(original));
	let text = stripToolFragments(original)
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\v\f]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	text = collapseRepeatedParagraphs(text);
	if (text.length > MAX_IRC_REPLY_CHARS) text = text.slice(0, MAX_IRC_REPLY_CHARS).trimEnd();
	if (!text) return { text: null, droppedReason: hadToolFragment ? "tool_fragment" : "empty" };
	return { text, ...(hadToolFragment ? { droppedReason: "tool_fragment" as const } : {}) };
}

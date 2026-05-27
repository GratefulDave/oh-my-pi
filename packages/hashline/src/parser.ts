/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 *
 * Lifecycle:
 *
 * 1. Construct one {@link Executor} per hunk (or share one with `reset()`).
 * 2. Feed it tokens via {@link Executor.feed}. Multi-line payloads are
 *    accumulated across tokens until the next op flushes them.
 * 3. Call {@link Executor.end} to flush the trailing pending op and validate
 *    cross-op invariants (no overlapping deletes, etc.).
 *
 * Convenience entry point: {@link parsePatch}.
 */
import {
	HL_OP_CHARS,
	HL_OP_DELETE,
	HL_OP_INSERT_AFTER,
	HL_OP_INSERT_BEFORE,
	HL_OP_REPLACE,
	HL_PAYLOAD_PREFIX,
} from "./format";
import {
	ABORT_WARNING,
	INLINE_PAYLOAD_ACCEPTED_WARNING,
	PAYLOAD_LINE_PREFIX_DEMOTED_WARNING,
	REPLACE_PAIR_COALESCED_WARNING,
} from "./messages";
import { cloneCursor, isDeleteOpWithPayload, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, Cursor, Edit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}-${range.end.line} ends before it starts.`);
	}
}

function rangesEqual(a: ParsedRange, b: ParsedRange): boolean {
	return a.start.line === b.start.line && a.end.line === b.end.line;
}

function rangeContains(outer: ParsedRange, inner: ParsedRange): boolean {
	return outer.start.line <= inner.start.line && inner.end.line <= outer.end.line;
}

function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) {
		anchors.push({ line });
	}
	return anchors;
}

type PendingOp =
	| { kind: "insert"; cursor: Cursor; lineNum: number }
	| { kind: "replace"; range: ParsedRange; lineNum: number };

interface Pending {
	op: PendingOp;
	payload: string[];
}

/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s.
 *
 * `feed()` accepts tokens one at a time; multi-line payloads accumulate
 * until the next op or {@link end} flushes them. After `terminated` flips
 * true (on `envelope-end` or `abort`) subsequent feeds are silently ignored
 * so callers can keep draining their tokenizer.
 */
export class Executor {
	#edits: Edit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#terminated = false;
	/**
	 * Count of blank tokens buffered since the last non-blank token. Blank lines
	 * are only absorbed into the pending payload when followed by another `+`
	 * payload line; when followed by an op or header they are dropped as
	 * inter-op separators.
	 */
	#pendingBlanks = 0;

	/** True once an `envelope-end` or `abort` token has been observed. */
	get terminated(): boolean {
		return this.#terminated;
	}

	/**
	 * Consume one token. After `terminated` flips true subsequent feeds are
	 * silently ignored so callers can keep draining their tokenizer without
	 * explicit early-exit guards.
	 */
	feed(token: Token): void {
		if (this.#terminated) return;

		switch (token.kind) {
			case "envelope-begin":
				return;
			case "envelope-end":
				this.#terminated = true;
				return;
			case "abort":
				this.#warnings.push(ABORT_WARNING);
				this.#terminated = true;
				return;
			case "header":
				this.#flushPending();
				return;
			case "blank":
				if (this.#pending) this.#pendingBlanks++;
				return;
			case "payload":
				this.#flushPendingBlanks();
				this.#handlePayload(token.text, token.lineNum);
				return;
			case "op-delete":
				this.#flushPending();
				if (token.trailingPayload) {
					throw new Error(
						`line ${token.lineNum}: ${HL_OP_DELETE} deletes only. Payload is forbidden after ${HL_OP_DELETE}; use ${HL_OP_REPLACE} to replace.`,
					);
				}
				validateRangeOrder(token.range, token.lineNum);
				for (const anchor of expandRange(token.range)) {
					this.#edits.push({ kind: "delete", anchor, lineNum: token.lineNum, index: this.#editIndex++ });
				}
				return;
			case "op-insert":
				this.#flushPending();
				this.#pending = {
					op: { kind: "insert", cursor: token.cursor, lineNum: token.lineNum },
					payload: [],
				};
				if (token.inlineBody !== undefined) {
					this.#pending.payload.push(token.inlineBody);
				}
				return;
			case "op-replace":
				validateRangeOrder(token.range, token.lineNum);
				if (this.#pending !== undefined && this.#pending.op.kind === "replace") {
					const outer = this.#pending.op.range;
					const inner = token.range;
					if (rangesEqual(outer, inner)) {
						// Identical-range before/after pair — drop "before" payload, second op wins.
						this.#pending = undefined;
						if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_WARNING)) {
							this.#warnings.push(REPLACE_PAIR_COALESCED_WARNING);
						}
					} else if (rangeContains(outer, inner)) {
						// Inner op is inside outer range — demote to payload continuation.
						this.#pending.payload.push(token.inlineBody ?? "");
						if (!this.#warnings.includes(PAYLOAD_LINE_PREFIX_DEMOTED_WARNING)) {
							this.#warnings.push(PAYLOAD_LINE_PREFIX_DEMOTED_WARNING);
						}
						return;
					}
				}
				this.#flushPending();
				this.#pending = {
					op: { kind: "replace", range: token.range, lineNum: token.lineNum },
					payload: [],
				};
				if (token.inlineBody !== undefined) {
					this.#pending.payload.push(token.inlineBody);
					if (!this.#warnings.includes(INLINE_PAYLOAD_ACCEPTED_WARNING)) {
						this.#warnings.push(INLINE_PAYLOAD_ACCEPTED_WARNING);
					}
				}
				return;
		}
	}

	/**
	 * Flush any open pending op (with its full accumulated payload, including
	 * explicit `+` blank lines) and return the accumulated edits and
	 * warnings. The executor is single-use; {@link reset} is required for
	 * reuse.
	 *
	 * Throws if two replace/delete ops target the same line with non-identical
	 * shapes (different ranges, replace+delete, delete+delete). Identical-range
	 * `A-B:` pairs in the same hunk are coalesced last-wins by `feed()` with a
	 * warning, so they never reach the validator.
	 */
	end(): { edits: Edit[]; warnings: string[] } {
		this.#flushPending();
		this.#validateNoOverlappingDeletes();
		return { edits: this.#edits, warnings: this.#warnings };
	}

	/** Reset to a fresh state so the same instance can drive another parse. */
	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#terminated = false;
		this.#pendingBlanks = 0;
	}

	/**
	 * Flush any buffered blank lines into the pending payload. Called before
	 * processing a `+` payload line so that blanks between payload lines are
	 * preserved. When called from `#flushPending` (op/header boundary) the
	 * buffered blanks are simply discarded — they were inter-op separators.
	 */
	#flushPendingBlanks(): void {
		if (this.#pendingBlanks > 0 && this.#pending) {
			for (let i = 0; i < this.#pendingBlanks; i++) {
				this.#pending.payload.push("");
			}
		}
		this.#pendingBlanks = 0;
	}

	/**
	 * Each `:` / `!` op contributes a delete edit per line in its range; if
	 * any line ends up targeted by deletes originating from two different
	 * source ops (distinguished by their `lineNum`), the patch is internally
	 * inconsistent. Common shape: a "before" `A-B:` followed by an "after"
	 * `A-B:` over the same range, or an `A-B:` that overlaps a later `N!` /
	 * `N:`. The applier would run both literally and the file would end up
	 * with two copies of the line, not a chosen winner.
	 */
	#validateNoOverlappingDeletes(): void {
		const sourceLinesByAnchor = new Map<number, number[]>();
		for (const edit of this.#edits) {
			if (edit.kind !== "delete") continue;
			let sourceLines = sourceLinesByAnchor.get(edit.anchor.line);
			if (sourceLines === undefined) {
				sourceLines = [];
				sourceLinesByAnchor.set(edit.anchor.line, sourceLines);
			}
			if (!sourceLines.includes(edit.lineNum)) sourceLines.push(edit.lineNum);
		}
		for (const [anchorLine, sourceLines] of sourceLinesByAnchor) {
			if (sourceLines.length < 2) continue;
			const [firstOp, secondOp] = [...sourceLines].sort((a, b) => a - b);
			throw new Error(
				`line ${secondOp}: anchor line ${anchorLine} is already targeted by the ${HL_OP_REPLACE}/${HL_OP_DELETE} op on line ${firstOp}. ` +
					`Issue ONE op per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
	}

	#handlePayload(text: string, lineNum: number): void {
		if (this.#pending) {
			this.#pending.payload.push(text);
			return;
		}

		// Orphan line outside any pending op — emit the most actionable diagnostic.
		if (isDeleteOpWithPayload(text)) {
			throw new Error(
				`line ${lineNum}: ${HL_OP_DELETE} deletes only. Payload is forbidden after ${HL_OP_DELETE}; use ${HL_OP_REPLACE} to replace.`,
			);
		}
		const firstChar = text[0];
		const startsWithOp = firstChar !== undefined && HL_OP_CHARS.includes(firstChar);
		if (startsWithOp || firstChar === "-" || firstChar === "@" || firstChar === "«" || firstChar === "»") {
			throw new Error(
				`line ${lineNum}: unrecognized op. Use LINE${HL_OP_INSERT_BEFORE} (insert before), LINE${HL_OP_INSERT_AFTER} (insert after), LINE${HL_OP_REPLACE} / A-B${HL_OP_REPLACE} (replace), or LINE${HL_OP_DELETE} / A-B${HL_OP_DELETE} (delete). ` +
					`Got ${JSON.stringify(text)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding ${HL_OP_INSERT_BEFORE}, ${HL_OP_INSERT_AFTER}, ${HL_OP_REPLACE}, or ${HL_OP_DELETE} operation. ` +
				`Got ${JSON.stringify(`${HL_PAYLOAD_PREFIX}${text}`)}.`,
		);
	}

	#flushPending(): void {
		this.#pendingBlanks = 0; // discard — blank lines before an op are separators, not payload
		const pending = this.#pending;
		if (!pending) return;

		const { op, payload } = pending;
		const linesToInsert = payload.length === 0 ? [""] : payload;

		if (op.kind === "insert") {
			for (const text of linesToInsert) {
				this.#edits.push({
					kind: "insert",
					cursor: cloneCursor(op.cursor),
					text,
					lineNum: op.lineNum,
					index: this.#editIndex++,
				});
			}
		} else {
			for (const text of linesToInsert) {
				this.#edits.push({
					kind: "insert",
					cursor: { kind: "before_anchor", anchor: { ...op.range.start } },
					text,
					lineNum: op.lineNum,
					index: this.#editIndex++,
				});
			}
			for (const anchor of expandRange(op.range)) {
				this.#edits.push({ kind: "delete", anchor, lineNum: op.lineNum, index: this.#editIndex++ });
			}
		}

		this.#pending = undefined;
	}
}

/**
 * Drive a full hashline diff through the tokenizer + executor pipeline and
 * return the resulting edits plus any parse-time warnings. This is the
 * convenience entry point most callers want; reach for {@link Tokenizer} /
 * {@link Executor} directly only when you need streaming feeds, cross-section
 * state, or custom token handling.
 */
export function parsePatch(diff: string): { edits: Edit[]; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	const drain = (tokens: Token[]): void => {
		for (const token of tokens) {
			if (executor.terminated) return;
			executor.feed(token);
		}
	};
	drain(tokenizer.feed(diff));
	drain(tokenizer.end());
	return executor.end();
}

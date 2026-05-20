import type { AssistantMessage, AssistantMessageEvent } from "../types";

export interface EventStreamOptions<T> {
	maxQueueSize?: number;
	coalesceQueuedEvent?: (queued: T, next: T) => T | undefined;
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	queue: T[] = [];
	waiting: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (err: unknown) => void }> = [];
	done = false;
	#failed = false;
	#error: unknown = undefined;
	finalResultPromise: Promise<R>;
	resolveFinalResult!: (result: R) => void;
	rejectFinalResult!: (err: unknown) => void;
	isComplete: (event: T) => boolean;
	extractResult: (event: T) => R;
	#maxQueueSize: number | undefined;
	#coalesceQueuedEvent: ((queued: T, next: T) => T | undefined) | undefined;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R, options?: EventStreamOptions<T>) {
		const { promise, resolve, reject } = Promise.withResolvers<R>();
		// Prevent an unhandled rejection when fail() is called but nobody awaits result().
		// Callers who do await result() still receive the rejection normally.
		promise.catch(() => {});
		this.finalResultPromise = promise;
		this.resolveFinalResult = resolve;
		this.rejectFinalResult = reject;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.#maxQueueSize =
			options?.maxQueueSize === undefined ? undefined : Math.max(1, Math.floor(options.maxQueueSize));
		this.#coalesceQueuedEvent = options?.coalesceQueuedEvent;
	}

	push(event: T): void {
		if (this.done) return;

		const complete = this.isComplete(event);
		if (complete) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		this.deliver(event, complete);
	}

	deliver(event: T, bypassQueueLimit = false): void {
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
			return;
		}

		const lastIndex = this.queue.length - 1;
		const last = this.queue[lastIndex];
		if (last !== undefined && this.#coalesceQueuedEvent) {
			const coalesced = this.#coalesceQueuedEvent(last, event);
			if (coalesced !== undefined) {
				this.queue[lastIndex] = coalesced;
				return;
			}
		}

		if (!bypassQueueLimit && this.#maxQueueSize !== undefined && this.queue.length >= this.#maxQueueSize) {
			this.fail(new Error(`EventStream queue exceeded ${this.#maxQueueSize} queued events`));
			return;
		}

		this.queue.push(event);
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	endWaiting(): void {
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	fail(err: unknown): void {
		if (this.done) return;
		this.done = true;
		this.#failed = true;
		this.#error = err;
		this.rejectFinalResult(err);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.reject(err);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.#failed) {
				throw this.#error;
			} else if (this.done) {
				return;
			} else {
				const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<T>>();
				this.waiting.push({ resolve, reject });
				const result = await promise;
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

function coalesceAssistantMessageEvent(
	queued: AssistantMessageEvent,
	next: AssistantMessageEvent,
): AssistantMessageEvent | undefined {
	if (queued.contentIndex !== next.contentIndex) return undefined;

	if (queued.type === "text_delta" && next.type === "text_delta") {
		return { ...next, delta: queued.delta + next.delta };
	}

	if (queued.type === "thinking_delta" && next.type === "thinking_delta") {
		return { ...next, delta: queued.delta + next.delta };
	}

	if (queued.type === "toolcall_delta" && next.type === "toolcall_delta") {
		return { ...next, delta: queued.delta + next.delta };
	}

	return undefined;
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
			{ maxQueueSize: 2048, coalesceQueuedEvent: coalesceAssistantMessageEvent },
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;

		const complete = this.isComplete(event);
		// Completion resolves the final result and still emits the terminal event.
		if (complete) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		this.deliver(event, complete);
	}

	override end(result?: AssistantMessage): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		this.endWaiting();
	}
}

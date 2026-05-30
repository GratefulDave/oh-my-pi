import { Snowflake } from "@oh-my-pi/pi-utils";

export interface ActorMessage {
	id: string;
	senderId: string;
	recipientId: string;
	content: string;
	timestamp: number;
	status: "queued" | "delivered" | "read";
}

export class ActorMailbox {
	readonly #messages: ActorMessage[] = [];

	enqueue(senderId: string, recipientId: string, content: string): ActorMessage {
		const message: ActorMessage = {
			id: `msg-${Snowflake.next()}`,
			senderId,
			recipientId,
			content,
			timestamp: Date.now(),
			status: "queued",
		};
		this.#messages.push(message);
		return message;
	}

	dequeue(): ActorMessage | undefined {
		return this.#messages.shift();
	}

	peek(): ActorMessage | undefined {
		return this.#messages[0];
	}

	list(): ActorMessage[] {
		return [...this.#messages];
	}

	listUnread(): ActorMessage[] {
		return this.#messages.filter(msg => msg.status !== "read");
	}

	markAsRead(messageId: string): void {
		const msg = this.#messages.find(m => m.id === messageId);
		if (msg) {
			msg.status = "read";
		}
	}

	markAllAsRead(): void {
		for (const msg of this.#messages) {
			msg.status = "read";
		}
	}

	clear(): void {
		this.#messages.length = 0;
	}

	get count(): number {
		return this.#messages.length;
	}

	get unreadCount(): number {
		return this.#messages.filter(msg => msg.status !== "read").length;
	}
}

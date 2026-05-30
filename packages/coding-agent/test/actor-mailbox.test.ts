import { describe, expect, test } from "bun:test";
import { ActorMailbox } from "../src/registry/mailbox";

describe("ActorMailbox", () => {
	test("enqueues and peeks/dequeues in FIFO order", () => {
		const mailbox = new ActorMailbox();
		expect(mailbox.count).toBe(0);

		const msg1 = mailbox.enqueue("sender-A", "recipient-B", "hello 1");
		const msg2 = mailbox.enqueue("sender-A", "recipient-B", "hello 2");

		expect(mailbox.count).toBe(2);
		expect(mailbox.unreadCount).toBe(2);

		expect(mailbox.peek()?.id).toBe(msg1.id);
		expect(mailbox.peek()?.content).toBe("hello 1");

		const dequeued1 = mailbox.dequeue();
		expect(dequeued1?.id).toBe(msg1.id);
		expect(mailbox.count).toBe(1);

		const dequeued2 = mailbox.dequeue();
		expect(dequeued2?.id).toBe(msg2.id);
		expect(mailbox.count).toBe(0);
	});

	test("tracks read and unread status correctly", () => {
		const mailbox = new ActorMailbox();
		const msg1 = mailbox.enqueue("sender-A", "recipient-B", "msg 1");
		const msg2 = mailbox.enqueue("sender-A", "recipient-B", "msg 2");

		expect(mailbox.listUnread()).toHaveLength(2);

		mailbox.markAsRead(msg1.id);
		expect(mailbox.unreadCount).toBe(1);
		expect(mailbox.listUnread()[0].id).toBe(msg2.id);

		mailbox.markAllAsRead();
		expect(mailbox.unreadCount).toBe(0);
		expect(mailbox.listUnread()).toHaveLength(0);
		expect(mailbox.list()).toHaveLength(2);
	});

	test("clears mailbox properly", () => {
		const mailbox = new ActorMailbox();
		mailbox.enqueue("sender-A", "recipient-B", "msg 1");
		mailbox.enqueue("sender-A", "recipient-B", "msg 2");

		expect(mailbox.count).toBe(2);
		mailbox.clear();
		expect(mailbox.count).toBe(0);
		expect(mailbox.list()).toHaveLength(0);
	});
});

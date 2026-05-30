/**
 * SessionObserverOverlayComponent — overview pane UX contract tests.
 *
 * Verifies:
 *  1. When subagents exist, the overlay defaults to overview pane (not closing).
 *  2. The overview table renders headers: Agent, Task, Status, Message.
 *  3. Seeded subagent data appears as a row under the headers.
 *
 * NOTE: Keyboard navigation (Enter → detail, Esc → overview) is not tested here
 * because it requires synthetic TUI key events and would be brittle. The state
 * shape contract (mode transitions) is covered by the production component; we
 * test only the rendered output that users actually see.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_OBSERVER_CHANNEL, type AsyncJobObserverPayload } from "../src/async";
import { SessionObserverOverlayComponent } from "../src/modes/components/session-observer-overlay";
import { type ObserverRow, SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

// ---------------------------------------------------------------------------
// Theme setup — the overlay renders via the global `theme` singleton.
// ---------------------------------------------------------------------------

beforeAll(async () => {
	await initTheme();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistryWithAgent(
	id: string,
	agent: string,
	description: string,
): { registry: SessionObserverRegistry; bus: EventBus } {
	const bus = new EventBus();
	const registry = new SessionObserverRegistry();
	registry.subscribeToEventBus(bus);

	const lifecycle: SubagentLifecyclePayload = {
		id,
		agent,
		agentSource: "bundled",
		description,
		status: "started",
		index: 0,
	};
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);

	return { registry, bus };
}

function stripAnsi(s: string): string {
	// Remove all ANSI escape sequences (colors, bold, etc.)
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionObserverOverlayComponent — overview pane", () => {
	it("does not call onDone immediately when at least one subagent exists", async () => {
		const { registry } = makeRegistryWithAgent("sa-001", "explore", "Analyze git history");

		let doneCalled = false;
		void new SessionObserverOverlayComponent(registry, () => {
			doneCalled = true;
		}, []);

		// Allow any microtasks to run
		await Bun.sleep(10);

		expect(doneCalled).toBe(false);
	});

	it("renders overview headers Agent, Task, Status, Message", async () => {
		const { registry } = makeRegistryWithAgent("sa-002", "explore", "Analyze git history");

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const lines = overlay.render(120);
		const fullText = stripAnsi(lines.join("\n"));

		expect(fullText).toContain("Agent");
		expect(fullText).toContain("Task");
		expect(fullText).toContain("Status");
		expect(fullText).toContain("Message");
	});

	it("renders sanitized output that includes Agent, Task, Status, Message headers", async () => {
		const { registry } = makeRegistryWithAgent("sa-003", "explore", "Analyze git history");

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const rendered = sanitizeText(overlay.render(120).join("\n"));

		expect(rendered).toContain("Agent");
		expect(rendered).toContain("Task");
		expect(rendered).toContain("Status");
		expect(rendered).toContain("Message");
	});

	it("renders seeded agent name in a row", async () => {
		const { registry } = makeRegistryWithAgent("sa-004", "explore", "Analyze git history");

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// The agent name should appear in the overview row
		expect(fullText).toContain("explore");
	});

	it("renders seeded task description in a row", async () => {
		const { registry } = makeRegistryWithAgent("sa-005", "explore", "Analyze git history");

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// Task column has fixed width; description may be truncated with "…". Check the prefix.
		expect(fullText).toContain("Analyze git");
	});

	it("allocates enough overview width for useful task labels", async () => {
		const { registry } = makeRegistryWithAgent(
			"sa-005-wide",
			"oracle",
			"Implement payment reconciliation worker",
		);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("Implement payment reconciliation");
	});

	it("renders status for the seeded agent", async () => {
		const { registry } = makeRegistryWithAgent("sa-006", "explore", "Analyze git history");

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// active status from lifecycle "started"
		expect(fullText).toMatch(/active|running/);
	});

	it("reflects progress message in the Message column when progress is emitted", async () => {
		const { registry, bus } = makeRegistryWithAgent("sa-007", "explore", "Analyze git history");

		// Emit a progress update with lastIntent
		const progress: SubagentProgressPayload = {
			index: 0,
			agent: "explore",
			agentSource: "bundled",
			task: "Analyze git history",
			assignment: "Analyze the git history.",
			progress: {
				index: 0,
				id: "sa-007",
				agent: "explore",
				agentSource: "bundled",
				status: "running",
				task: "Analyze git history",
				description: "Analyze git history",
				assignment: "Analyze the git history.",
				lastIntent: "thinking…",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				cost: 0,
				durationMs: 100,
			},
		};
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// "thinking" should appear somewhere in the rendered output
		expect(fullText).toContain("thinking");
	});

	it("shows multiple agents in the overview when multiple are seeded", async () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);

		const agents = [
			{ id: "sa-010", agent: "explore", description: "Analyze git history" },
			{ id: "sa-011", agent: "task", description: "Run tests" },
		];

		for (const a of agents) {
			const payload: SubagentLifecyclePayload = {
				id: a.id,
				agent: a.agent,
				agentSource: "bundled",
				description: a.description,
				status: "started",
				index: agents.indexOf(a),
			};
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		}

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("explore");
		expect(fullText).toContain("task");
		// Task column has fixed width — check prefixes that are guaranteed to fit.
		expect(fullText).toContain("Analyze git");
		expect(fullText).toContain("Run tests");
	});

	it("calls onDone via microtask when no subagents are registered", async () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);
		// No agents emitted — registry is empty.

		let doneCalled = false;
		void new SessionObserverOverlayComponent(registry, () => {
			doneCalled = true;
		}, []);

		// Give microtask queue a chance to flush.
		await Bun.sleep(10);

		expect(doneCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Overlay renders from getObserverRows — no source-specific derivation in overlay
// ---------------------------------------------------------------------------

// (imports are at the top of the file)

describe("SessionObserverOverlayComponent — getObserverRows integration", () => {
	it("renders async bash job agent/task from registry row model", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "ov-bash-job",
			type: "bash",
			label: "tail -f server.log",
			status: "running",
			startTime: Date.now(),
		} satisfies AsyncJobObserverPayload);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// Agent from row model: bash job type → "bash"
		expect(fullText).toContain("bash");
		// Task from row model: asyncJob.label (may be truncated to column width)
		expect(fullText).toContain("tail -f serv");
	});

	it("renders plugin agent/task from registry row model without source-specific overlay logic", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);

		bus.emit("subagents:started", {
			id: "ov-plugin-agent",
			type: "reviewer",
			description: "Review the PR",
		});

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("reviewer");
		expect(fullText).toContain("Review the PR");
	});

	it("renders plugin message field in Message column when present", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);

		bus.emit("subagents:started", {
			id: "ov-plugin-msg",
			type: "coder",
			description: "Coding task",
			message: "Setting up environment",
		});

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(160).join("\n"));

		expect(fullText).toContain("Setting up environment");
	});

	it("overlay overview rows match getObserverRows from registry directly", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "ov-core-match",
			agent: "explore",
			agentSource: "bundled" as const,
			description: "Explore codebase",
			status: "started",
			index: 0,
		} satisfies SubagentLifecyclePayload);

		const rows: ObserverRow[] = registry.getObserverRows();
		const row = rows.find(r => r.id === "ov-core-match");
		expect(row).toBeDefined();
		expect(row?.agent).toBe("explore");
		expect(row?.task).toBe("Explore codebase");
		expect(row?.status).toBe("running");

		// Overlay should render these same values
		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));
		expect(fullText).toContain("explore");
		expect(fullText).toContain("Explore codebase");
	});

	it("overlay shows cancelled for async job with cancelled status", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus);

		bus.emit(ASYNC_JOB_OBSERVER_CHANNEL, {
			id: "ov-bash-cancel",
			type: "bash",
			label: "long command",
			status: "cancelled",
			startTime: Date.now(),
		} satisfies AsyncJobObserverPayload);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		const fullText = stripAnsi(overlay.render(120).join("\n"));
		expect(fullText).toContain("cancelled");
	});
});

// ---------------------------------------------------------------------------
// IRC custom_message transcript rendering
// ---------------------------------------------------------------------------

/** Write a JSONL session file and return its path. Each element is JSON-serialized as a line. */
function writeTempSessionFile(entries: unknown[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-test-"));
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, `${entries.map(e => JSON.stringify(e)).join("\n")}\n`, "utf-8");
	return file;
}

describe("SessionObserverOverlayComponent — IRC transcript rendering", () => {
	it("renders persisted irc:incoming custom_message in detail transcript", () => {
		const sessionFile = writeTempSessionFile([
			// Minimal session header
			{ type: "header", version: 3, sessionId: "test-irc-session" },
			// Normal user message
			{
				type: "message",
				id: "m1",
				parentId: null,
				message: {
					role: "user",
					content: "Hello agent",
					timestamp: new Date().toISOString(),
				},
			},
			// IRC custom_message entry
			{
				type: "custom_message",
				id: "irc1",
				parentId: "m1",
				customType: "irc:incoming",
				content: "[IRC `0-Main` → you]\n\nHello from main agent, what is your status?",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		// Enter detail view (simulate Enter key), then expand the selected IRC entry
		overlay.handleInput("\r");
		overlay.handleInput("\r"); // expand last (IRC) entry
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("IRC");
		expect(fullText).toContain("Hello from main agent");
	});

	it("renders irc:autoreply custom_message in detail transcript", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-irc-autoreply" },
			{
				type: "custom_message",
				id: "irc2",
				parentId: null,
				customType: "irc:autoreply",
				content: "[IRC you → `0-Main` (auto)]\n\nProcessing your request now.",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		overlay.handleInput("\r"); // expand IRC entry
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("IRC");
		expect(fullText).toContain("Processing your request now");
	});

	it("renders irc:relay custom_message in detail transcript", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-irc-relay" },
			{
				type: "custom_message",
				id: "irc3",
				parentId: null,
				customType: "irc:relay",
				content: "[IRC `peer-A` → `peer-B`]\n\nRelay message body here.",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		overlay.handleInput("\r"); // expand IRC entry
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("IRC");
		expect(fullText).toContain("Relay message body here");
	});

	it("renders irc_message custom_message in detail transcript", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-irc-message" },
			{
				type: "custom_message",
				id: "irc4",
				parentId: null,
				customType: "irc_message",
				content: "Direct IRC message content.",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("IRC");
		expect(fullText).toContain("Direct IRC message content");
	});

	it("renders expanded IRC entry after Enter key (markdown view)", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-irc-expand" },
			{
				type: "custom_message",
				id: "irc5",
				parentId: null,
				customType: "irc:incoming",
				content: "Line one from IRC\nLine two from IRC\nLine three from IRC",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		// Enter detail, then expand the entry
		overlay.handleInput("\r");
		overlay.handleInput("\r"); // expand selected entry
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("IRC");
		// Expanded: should contain full body text
		expect(fullText).toContain("Line one from IRC");
	});

	it("does NOT render non-IRC custom_message entries in transcript", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-non-irc" },
			{
				type: "custom_message",
				id: "cm1",
				parentId: null,
				customType: "handoff",
				content: "This is a handoff message and must not appear.",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// The content of the handoff must not be rendered
		expect(fullText).not.toContain("This is a handoff message");
		// And no spurious IRC label
		expect(fullText).not.toContain("[IRC]");
	});

	it("interleaves IRC entries with normal messages in transcript order", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-irc-interleave" },
			{
				type: "message",
				id: "m1",
				parentId: null,
				message: {
					role: "user",
					content: "Initial user prompt",
					timestamp: new Date().toISOString(),
				},
			},
			{
				type: "custom_message",
				id: "irc6",
				parentId: "m1",
				customType: "irc:incoming",
				content: "Interleaved IRC message",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("Initial user prompt");
		expect(fullText).toContain("IRC");
		expect(fullText).toContain("Interleaved IRC message");
	});
});

// ---------------------------------------------------------------------------
// IRC directional label rendering
// ---------------------------------------------------------------------------

describe("SessionObserverOverlayComponent — IRC directional labels", () => {
	it("incoming with details.from renders [IRC <from> → you]", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-dir-incoming" },
			{
				type: "custom_message",
				id: "irc-dir-1",
				parentId: null,
				customType: "irc:incoming",
				content: "Hello from main agent, what is your status?",
				details: { from: "0-Main", message: "Hello from main agent, what is your status?" },
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("[IRC 0-Main → you]");
		expect(fullText).toContain("Hello from main agent");
	});

	it("autoreply with details.to renders [IRC you → <to> (auto)]", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-dir-autoreply" },
			{
				type: "custom_message",
				id: "irc-dir-2",
				parentId: null,
				customType: "irc:autoreply",
				content: "Processing your request now.",
				details: { to: "0-Main", reply: "Processing your request now." },
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("[IRC you → 0-Main (auto)]");
		expect(fullText).toContain("Processing your request now");
	});

	it("relay with details { from, to, kind: 'message' } renders [IRC <from> → <to>]", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-dir-relay" },
			{
				type: "custom_message",
				id: "irc-dir-3",
				parentId: null,
				customType: "irc:relay",
				content: "Relay message body here.",
				details: { from: "peer-A", to: "peer-B", kind: "message" },
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("[IRC peer-A → peer-B]");
		expect(fullText).toContain("Relay message body here");
	});

	it("relay with kind 'reply' renders [IRC <from> → (auto) <to>]", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-dir-relay-reply" },
			{
				type: "custom_message",
				id: "irc-dir-4",
				parentId: null,
				customType: "irc:relay",
				content: "Auto-reply forwarded.",
				details: { from: "peer-A", to: "peer-B", kind: "reply" },
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		expect(fullText).toContain("[IRC peer-A → (auto) peer-B]");
		expect(fullText).toContain("Auto-reply forwarded");
	});

	it("content-prefix fallback uses first [IRC ...] line as label and does not duplicate it in body", () => {
		const sessionFile = writeTempSessionFile([
			{ type: "header", version: 3, sessionId: "test-dir-prefix" },
			{
				type: "custom_message",
				id: "irc-dir-5",
				parentId: null,
				customType: "irc:incoming",
				// No details — label is embedded in content
				content: "[IRC 0-Main → you]\n\nBody text after the prefix.",
				display: true,
			},
		]);

		const registry = new SessionObserverRegistry();
		registry.registerStandaloneSession(sessionFile);

		const overlay = new SessionObserverOverlayComponent(registry, () => {}, []);
		overlay.handleInput("\r");
		overlay.handleInput("\r"); // expand to see full body
		const fullText = stripAnsi(overlay.render(120).join("\n"));

		// Label appears once
		expect(fullText).toContain("[IRC 0-Main → you]");
		// Body is shown
		expect(fullText).toContain("Body text after the prefix");
		// Label prefix is not duplicated in body
		const occurrences = (fullText.match(/\[IRC 0-Main → you\]/g) ?? []).length;
		expect(occurrences).toBe(1);
	});
});

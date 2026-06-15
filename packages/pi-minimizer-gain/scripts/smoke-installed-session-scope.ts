#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

interface Theme {
	boxSharp: { horizontal: string };
	bold(text: string): string;
	fg(color: string, text: string): string;
}

interface Tui {
	requestRender(): void;
}

interface RenderableOverlay {
	act(key: string): boolean;
	render(width: number): string[];
	dispose?(): void;
}

interface Ui {
	setEditorText(value: string): void;
	custom(
		factory: (tui: Tui, theme: Theme, keybindings: unknown, done: (value: undefined) => void) => unknown,
		options: { overlay: boolean },
	): Promise<void>;
}

interface CommandContext {
	cwd: string;
	ui: Ui;
	sessionManager: {
		getHeader(): { id?: string; timestamp?: string } | null;
		getEntries(): readonly unknown[];
		getSessionFile(): string | undefined;
	};
}

interface RegisteredCommand {
	description: string;
	handler(args: string, ctx: CommandContext): Promise<void>;
}

interface ExtensionApi {
	setLabel(value: string): void;
	registerCommand(name: string, command: RegisteredCommand): void;
}

type ExtensionFactory = (api: ExtensionApi) => void;

const INSTALLED_BUNDLE = path.join(os.homedir(), ".omp", "agent", "extensions", "pi-minimizer-gain", "gaing.bundle.js");
const WIDTH = 240;

function fail(message: string): never {
	throw new Error(message);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function getExtensionFactory(moduleValue: unknown): ExtensionFactory {
	const moduleObject = isObjectRecord(moduleValue) ? moduleValue : null;
	const exported = moduleObject?.default;
	if (typeof exported !== "function") {
		fail(`installed gain bundle does not export a default extension function: ${INSTALLED_BUNDLE}`);
	}
	return exported as ExtensionFactory;
}

function isRenderableOverlay(value: unknown): value is RenderableOverlay {
	const object = isObjectRecord(value) ? value : null;
	return typeof object?.act === "function" && typeof object.render === "function";
}

async function realpathExisting(dir: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	return fs.realpath(dir);
}

async function main(): Promise<void> {
	await fs.stat(INSTALLED_BUNDLE).catch(() => {
		fail(`installed gain bundle missing: ${INSTALLED_BUNDLE}`);
	});

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-minimizer-gain-smoke-"));
	let overlay: RenderableOverlay | undefined;
	try {
		const rootCwd = await realpathExisting(path.join(tempDir, "root"));
		const siblingCwd = await realpathExisting(path.join(tempDir, "sibling"));
		const outsideCwd = await realpathExisting(path.join(tempDir, "outside"));
		const agentDir = await realpathExisting(path.join(tempDir, "agent"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.OMP_AGENT_DIR = agentDir;

		const sessionStartedAt = "2026-06-15T10:00:00.000Z";
		const sessionId = "smoke-session";
		const recordsFile = path.join(agentDir, "minimizer-gain.jsonl");
		const now = "2026-06-15T10:00:01.000Z";
		const staleScopedRecord = {
			timestamp: "2026-06-15T09:59:59.000Z",
			cwd: siblingCwd,
			sessionCwd: rootCwd,
			command: "smoke stale command",
			filter: "smoke",
			inputBytes: 1200,
			outputBytes: 200,
			savedBytes: 1000,
			savedTokens: 250,
			exitCode: 0,
			kind: "saved",
		};
		const scopedSiblingRecord = {
			timestamp: now,
			cwd: siblingCwd,
			sessionCwd: rootCwd,
			sessionId,
			command: "smoke sibling command",
			filter: "smoke",
			inputBytes: 1200,
			outputBytes: 200,
			savedBytes: 1000,
			savedTokens: 250,
			exitCode: 0,
			kind: "saved",
		};
		const outOfScopeRecord = {
			timestamp: now,
			cwd: outsideCwd,
			sessionCwd: outsideCwd,
			command: "smoke outside command",
			filter: "smoke",
			inputBytes: 900,
			outputBytes: 100,
			savedBytes: 800,
			savedTokens: 200,
			exitCode: 0,
			kind: "saved",
		};
		await fs.writeFile(
			recordsFile,
			`${JSON.stringify(staleScopedRecord)}\n${JSON.stringify(scopedSiblingRecord)}\n${JSON.stringify(outOfScopeRecord)}\n`,
		);
		const sessionFile = path.join(agentDir, "sessions", "root", "active.jsonl");
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(
			sessionFile,
			[
				JSON.stringify({ type: "session", cwd: rootCwd, timestamp: sessionStartedAt }),
				JSON.stringify({
					type: "message",
					message: {
						content: [
							{
								type: "toolCall",
								name: "bash",
								arguments: { command: scopedSiblingRecord.command, cwd: siblingCwd },
							},
						],
					},
				}),
			].join("\n"),
		);

		// Intentional module-loading boundary smoke: the installed extension bundle path is what rebuild wires.
		const extensionModule = await import(url.pathToFileURL(INSTALLED_BUNDLE).href);
		const extension = getExtensionFactory(extensionModule);

		let label = "";
		const commands = new Map<string, RegisteredCommand>();
		extension({
			setLabel(value: string) {
				label = value;
			},
			registerCommand(name: string, command: RegisteredCommand) {
				commands.set(name, command);
			},
		});
		if (label !== "Minimizer Gain") fail(`unexpected extension label: ${label}`);
		const gain = commands.get("gain") ?? fail("gain command was not registered by installed bundle");

		const theme: Theme = {
			boxSharp: { horizontal: "─" },
			bold(text: string) {
				return text;
			},
			fg(_color: string, text: string) {
				return text;
			},
		};
		const ui: Ui = {
			setEditorText(_value: string) {},
			async custom(factory, options) {
				if (!options.overlay) fail("gain command did not request an overlay");
				const candidate = factory({ requestRender() {} }, theme, undefined, () => {});
				if (!isRenderableOverlay(candidate)) fail("gain overlay is not renderable");
				overlay = candidate;
			},
		};

		await gain.handler("", {
			cwd: rootCwd,
			ui,
			sessionManager: {
				getSessionFile() {
					return sessionFile;
				},
				getEntries() {
					return [
						{
							type: "message",
							message: {
								content: [
									{
										type: "toolCall",
										name: "bash",
										arguments: { command: scopedSiblingRecord.command, cwd: siblingCwd },
									},
								],
							},
						},
					];
				},
				getHeader() {
					return { id: sessionId, timestamp: sessionStartedAt };
				},
			},
		});
		if (!overlay) fail("gain command did not create an overlay");
		const activeRendered = overlay.render(WIDTH).join("\n");
		if (!activeRendered.includes("Token Savings (Active Session)")) {
			fail(`active session scope was not the default /gain view:\n${activeRendered}`);
		}
		if (!activeRendered.includes("Total commands: 1")) {
			fail(`active session scope did not include exactly the active timestamp-window record:\n${activeRendered}`);
		}
		overlay.act("tab");
		overlay.act("tab");
		const rendered = overlay.render(WIDTH).join("\n");

		if (!rendered.includes("Records (file-wide): 3")) {
			fail(`diagnostic did not read all smoke records:\n${rendered}`);
		}
		if (!rendered.includes("Records (in scope): 2")) {
			fail(`diagnostic scoped to ${rootCwd} did not include exactly the sibling session records:\n${rendered}`);
		}
		if (!rendered.includes(`Scope filter: ${rootCwd}`)) {
			fail(`diagnostic did not scope to the session root:\n${rendered}`);
		}

		console.log(`gain installed bundle session-scope smoke OK: ${path.relative(os.homedir(), INSTALLED_BUNDLE)}`);
	} finally {
		overlay?.dispose?.();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

await main();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import swarmExtension from "../extension";

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type NotifyLevel = Parameters<ExtensionCommandContext["ui"]["notify"]>[1];

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-extension-test-"));
});

afterEach(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

function registerExtension(): RegisteredCommandOptions {
	let registered: RegisteredCommandOptions | undefined;
	const pi = {
		setLabel: (_label: string) => undefined,
		registerCommand: (name: string, options: RegisteredCommandOptions) => {
			expect(name).toBe("swarm");
			registered = options;
		},
	} as unknown as ExtensionAPI;

	swarmExtension(pi);

	if (!registered) {
		throw new Error("swarm command was not registered");
	}
	return registered;
}

describe("swarm extension command registration", () => {
	it("registers /swarm run <file.yaml> without starting an agent process", async () => {
		const command = registerExtension();
		const completions = command.getArgumentCompletions?.("") ?? [];
		expect(completions.some(item => item.value === "run")).toBe(true);

		const notifications: Array<{ message: string; level: NotifyLevel }> = [];
		const ctx = {
			cwd: workspace,
			ui: {
				notify: (message: string, level: NotifyLevel) => {
					notifications.push({ message, level });
				},
			},
		} as unknown as ExtensionCommandContext;

		await command.handler(" run smoke.yaml ", ctx);

		expect(notifications).toEqual([
			{
				message: `Cannot read file: ${path.join(workspace, "smoke.yaml")}`,
				level: "error",
			},
		]);
	});
});

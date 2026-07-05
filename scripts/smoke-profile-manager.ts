import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

const extensionPath =
	process.argv[2] ?? path.join(os.homedir(), ".omp", "agent", "extensions", "profile-manager", "index.js");

const result = await loadExtensions([extensionPath], process.cwd());
if (result.errors.length > 0) {
	throw new Error(
		`profile-manager failed to load: ${result.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`,
	);
}

const extension = result.extensions[0];
if (!extension) {
	throw new Error(`profile-manager did not load from ${extensionPath}`);
}

const command = extension.commands.get("pm");
if (!command) {
	throw new Error("profile-manager did not register /pm");
}

const messages: unknown[] = [];
result.runtime.sendMessage = message => {
	messages.push(message);
};

await command.handler("list", {
	cwd: process.cwd(),
	hasUI: false,
	ui: {},
	modelRegistry: {
		getAll: () => [],
		find: () => undefined,
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
	},
	models: { list: () => [] },
	sessionManager: { getCwd: () => process.cwd() },
} as never);

const rendered = JSON.stringify(messages);
if (!rendered.includes("Model profiles:")) {
	throw new Error("profile-manager /pm list did not emit profile list output");
}

console.log("profile-manager smoke: /pm registered and /pm list emits output");

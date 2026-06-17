import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerFactoryCommands } from "./commands";
import { evaluateSafetyRule } from "./safety";

export default function softwareFactory(pi: ExtensionAPI): void {
	pi.setLabel("Software Factory");
	registerFactoryCommands(pi);
	pi.on("tool_call", async (event, ctx) => evaluateSafetyRule(event, ctx));
}

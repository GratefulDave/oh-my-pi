import { describe, expectTypeOf, it } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

describe("ExtensionAPI Zod schema contract", () => {
	it("accepts the injected Zod facade and infers tool arguments", () => {
		const parameters = zod.z.object({ message: zod.z.string() });
		const tool = {
			name: "zod_schema_contract",
			label: "Zod schema contract",
			parameters,
			description: "Validates injected Zod facade typing",
			async execute(_toolCallId, params) {
				expectTypeOf(params).toEqualTypeOf<{ message: string }>();
				return { content: [{ type: "text", text: params.message }] };
			},
		} satisfies ToolDefinition<typeof parameters>;

		const register = (api: Pick<ExtensionAPI, "registerTool">): void => api.registerTool(tool);
		expectTypeOf(register).toBeFunction();
	});
});

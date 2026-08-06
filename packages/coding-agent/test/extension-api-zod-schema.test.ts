import { describe, expectTypeOf, it } from "bun:test";
import type { Static, ZodV3Schema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { z } from "zod/v3";

describe("ExtensionAPI Zod v3 schema contract", () => {
	it("accepts an external Zod v3 schema and infers tool arguments", () => {
		const parameters = z.object({ message: z.string() });
		const accepted: ZodV3Schema = parameters;
		expectTypeOf(accepted).toMatchTypeOf<ZodV3Schema>();
		expectTypeOf<Static<typeof parameters>>().toEqualTypeOf<{ message: string }>();

		const tool = {
			name: "zod_v3_schema_contract",
			label: "Zod v3 schema contract",
			parameters,
			description: "Validates external Zod v3 typing",
			async execute(_toolCallId, params) {
				expectTypeOf(params).toEqualTypeOf<{ message: string }>();
				return { content: [{ type: "text", text: params.message }] };
			},
		} satisfies ToolDefinition<typeof parameters>;

		const register = (api: Pick<ExtensionAPI, "registerTool">): void => api.registerTool(tool);
		expectTypeOf(register).toBeFunction();
	});
});

import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { z } from "zod/v3";

const parameters = z.object({ message: z.string().default("hello") });
const tool: Tool<typeof parameters> = { name: "zod-v3", description: "", parameters };

describe("Zod v3 tool schemas", () => {
	it("serializes and validates an external schema", () => {
		const wire = toolWireSchema(tool);
		expect(wire).toMatchObject({
			type: "object",
			properties: { message: { type: "string", default: "hello" } },
		});
		expect(wire.required).toBeUndefined();

		const arguments_ = validateToolArguments(tool, {
			type: "toolCall",
			id: "zod-v3-default",
			name: tool.name,
			arguments: {},
		});
		expect(arguments_).toEqual({ message: "hello" });
	});

	it("coerces nested union members without duplicating Zod v3 issue paths", () => {
		const unionParameters = z.object({
			value: z.union([z.object({ ids: z.array(z.string()) }), z.object({ id: z.string() })]),
		});
		const unionTool: Tool<typeof unionParameters> = {
			name: "zod-v3-union",
			description: "",
			parameters: unionParameters,
		};

		const arguments_ = validateToolArguments(unionTool, {
			type: "toolCall",
			id: "zod-v3-union-coercion",
			name: unionTool.name,
			arguments: { value: { ids: "one" } },
		});

		expect(arguments_).toEqual({ value: { ids: ["one"] } });
	});
});

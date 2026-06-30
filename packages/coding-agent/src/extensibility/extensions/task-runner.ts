import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { TaskToolDetails } from "../../task/types";
import type { RunTaskHandler } from "./types";

export const EXTENSION_TASK_UNAVAILABLE_ERROR = "Task tool is not available in this session.";

type TaskToolInlineExecutor = {
	executeInline(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>>;
};

function getTaskTool(session: Pick<AgentSession, "getToolByName">): TaskToolInlineExecutor {
	const tool = session.getToolByName("task");
	const inlineTool = tool as unknown as Partial<TaskToolInlineExecutor> | undefined;
	if (!inlineTool || typeof inlineTool.executeInline !== "function") {
		throw new Error(EXTENSION_TASK_UNAVAILABLE_ERROR);
	}
	return inlineTool as TaskToolInlineExecutor;
}

export function createRunTaskAction(session: Pick<AgentSession, "getToolByName">): RunTaskHandler {
	return async (params, options) => {
		const taskTool = getTaskTool(session);
		return await taskTool.executeInline(
			options?.toolCallId ?? `extension-task-${Snowflake.next()}`,
			params,
			options?.signal,
			options?.onUpdate,
		);
	};
}

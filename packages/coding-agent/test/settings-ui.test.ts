import { describe, expect, it } from "bun:test";
import { getDefault } from "../src/config/settings-schema";
import { getSettingDef, getSettingsForTab } from "../src/modes/components/settings-defs";

describe("async task settings", () => {
	it("defaults background tasks to enabled with unlimited subagent concurrency", () => {
		expect(getDefault("async.enabled")).toBe(true);
		expect(getDefault("task.maxConcurrency")).toBe(0);
	});

	it("shows async execution and max task concurrency in the tasks settings tab", () => {
		const taskSettings = getSettingsForTab("tasks");
		const paths = taskSettings.map(setting => setting.path);

		expect(paths).toContain("async.enabled");
		expect(paths).toContain("task.maxConcurrency");
		expect(getSettingDef("async.enabled")).toMatchObject({
			tab: "tasks",
			type: "boolean",
			label: "Async Execution",
		});
		expect(getSettingDef("task.maxConcurrency")).toMatchObject({
			tab: "tasks",
			type: "submenu",
			label: "Max Concurrent Tasks",
			options: expect.arrayContaining([expect.objectContaining({ value: "0", label: "Unlimited" })]),
		});
	});
});

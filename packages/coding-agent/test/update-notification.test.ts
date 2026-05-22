import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { recordShownUpdateNotification, shouldShowNewVersionNotification } from "../src/main";

describe("update notification suppression", () => {
	it("shows each available version at most once", () => {
		const settings = Settings.isolated({});

		expect(shouldShowNewVersionNotification("15.2.3", settings)).toBe(true);
		recordShownUpdateNotification("15.2.3", settings);
		expect(settings.get("startup.lastShownUpdateVersion")).toBe("15.2.3");
		expect(shouldShowNewVersionNotification("15.2.3", settings)).toBe(false);
		expect(shouldShowNewVersionNotification("15.2.4", settings)).toBe(true);
	});

	it("does not show or persist when update checks are disabled", () => {
		const settings = Settings.isolated({ "startup.checkUpdate": false });

		expect(shouldShowNewVersionNotification("15.2.3", settings)).toBe(false);
		expect(settings.get("startup.lastShownUpdateVersion")).toBeUndefined();
	});
});

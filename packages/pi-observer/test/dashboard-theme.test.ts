import { describe, expect, test } from "bun:test";
import { getThemeByName } from "../../coding-agent/src/modes/theme/theme";
import { ObserverDashboard } from "../src/dashboard";
import { resetStats } from "../src/stats-collector";

describe("ObserverDashboard host theme integration", () => {
	test("renders through the real host Theme without a theme.dim method", async () => {
		resetStats();
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		if (!theme) throw new Error("Built-in dark theme unavailable");

		const dashboard = new ObserverDashboard(
			{
				fg: theme.fg.bind(theme),
				bold: theme.bold.bind(theme),
			},
			() => {},
			() => {},
		);
		try {
			const rendered = dashboard.render(80, 24).join("\n");
			expect(rendered).toContain("session-observability");
			expect(rendered).toContain("Real-time agents, tasks, intercom, and metrics");
			expect(rendered).toContain("Observability");
		} finally {
			dashboard.destroy();
		}
	});
});

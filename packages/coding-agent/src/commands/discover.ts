/**
 * Discover RTK savings opportunities.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type GainCommandArgs, runGainCommand } from "../cli/gain-cli";
import { initTheme } from "../modes/theme/theme";

export default class Discover extends Command {
	static description = "Discover RTK savings opportunities";

	static flags = {
		since: Flags.string({
			char: "s",
			description: "Time window to scan (e.g. 7d, 30d, 24h)",
			default: "7d",
		}),
		json: Flags.boolean({
			char: "j",
			description: "Output discover data as JSON",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Discover);

		let days = 7;
		if (flags.since) {
			const match = flags.since.match(/^(\d+)([dwh]?)$/i);
			if (match) {
				const num = parseInt(match[1], 10);
				const unit = match[2].toLowerCase();
				if (unit === "w") days = num * 7;
				else if (unit === "h") days = Math.max(1, Math.round(num / 24));
				else days = num;
			}
		}

		const cmd: GainCommandArgs = {
			json: flags.json,
			days,
			all: true,
			discover: true,
			missed: false,
			diag: false,
		};

		await initTheme();
		await runGainCommand(cmd);
	}
}

/**
 * View native shell minimizer token savings.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type GainCommandArgs, runGainCommand } from "../cli/gain-cli";
import { initTheme } from "../modes/theme/theme";

export default class Gain extends Command {
	static description = "View native shell minimizer token savings";

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output gain analytics as JSON", default: false }),
		days: Flags.integer({ char: "d", description: "Number of days to include", default: 30 }),
		cwd: Flags.string({ description: "Only include entries from this working directory" }),
		all: Flags.boolean({ description: "Include entries from all working directories", default: false }),
		discover: Flags.boolean({
			description: "Show highest observed native minimizer savings opportunities",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gain);
		const cmd: GainCommandArgs = {
			json: flags.json,
			days: flags.days,
			cwd: flags.cwd,
			all: flags.all,
			discover: flags.discover,
		};

		await initTheme();
		await runGainCommand(cmd);
	}
}

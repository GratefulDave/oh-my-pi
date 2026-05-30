/**
 * Install plugins from npm or configured marketplaces.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type PluginCommandArgs, runPluginCommand } from "../cli/plugin-cli";
import { initTheme } from "../modes/theme/theme";

export default class Install extends Command {
	static description = "Install a plugin from npm or a configured marketplace";

	static args = {
		targets: Args.string({
			description: "Packages or marketplace plugin refs",
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		force: Flags.boolean({ description: "Force install" }),
		"dry-run": Flags.boolean({ description: "Show actions without applying changes" }),
		scope: Flags.string({
			description: 'Install scope for marketplace refs: "user" (default) or "project"',
			options: ["user", "project"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Install);
		const targets = Array.isArray(args.targets) ? args.targets : args.targets === undefined ? [] : [args.targets];
		const cmd: PluginCommandArgs = {
			action: "install",
			args: targets,
			flags: {
				json: flags.json,
				force: flags.force,
				dryRun: flags["dry-run"],
				scope: flags.scope as "user" | "project" | undefined,
			},
		};

		await initTheme();
		await runPluginCommand(cmd);
	}
}

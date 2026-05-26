import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type ProfileAction, type ProfileCommandArgs, runProfileCommand } from "../cli/profile-cli";
import { isModelProfilePreset, MODEL_PROFILE_PRESETS } from "../config/model-profile-presets";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: ProfileAction[] = ["list", "show", "create", "use", "delete", "set"];

export default class Profile extends Command {
	static description = "Manage named model profiles";

	static args = {
		action: Args.string({
			description: "Profile action",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Profile name",
			required: false,
		}),
		key: Args.string({
			description: "Profile setting key",
			required: false,
		}),
		value: Args.string({
			description: "Profile setting value",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		empty: Flags.boolean({ description: "Create an empty profile" }),
		activate: Flags.boolean({ description: "Activate profile after creation" }),
		preset: Flags.string({
			description: "Profile preset to apply after creation",
			options: [...MODEL_PROFILE_PRESETS],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Profile);
		const action = (args.action ?? "list") as ProfileAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;
		const preset = flags.preset && isModelProfilePreset(flags.preset) ? flags.preset : undefined;
		if (flags.preset && !preset) {
			throw new Error(`Unknown profile preset: ${flags.preset}`);
		}
		const cmd: ProfileCommandArgs = {
			action,
			name: args.name,
			key: args.key,
			value,
			flags: {
				json: flags.json,
				empty: flags.empty,
				activate: flags.activate,
				preset,
			},
		};

		await initTheme();
		await runProfileCommand(cmd);
	}
}

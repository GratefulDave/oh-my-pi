import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SkillsOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/skills-overlay";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

describe("SkillsOverlayComponent", () => {
	it.each([
		["Enter/CR", "\r"],
		["Space", " "],
	])("forwards %s to the select list so overlay entries can be toggled", (_name, input) => {
		const onToggleSource = vi.fn();
		const component = new SkillsOverlayComponent(
			[{ id: "skills.enablePiUser", label: "Pi (user)", enabled: true, provider: "native" }],
			[],
			{ onToggleSource, onToggleSkill: vi.fn(), onDone: vi.fn() },
		);

		component.handleInput(input);

		expect(onToggleSource).toHaveBeenCalledTimes(1);
		expect(onToggleSource).toHaveBeenCalledWith("skills.enablePiUser");
	});

	it("forwards cancellation to close the overlay", () => {
		const onDone = vi.fn();
		const component = new SkillsOverlayComponent([], [], {
			onToggleSource: vi.fn(),
			onToggleSkill: vi.fn(),
			onDone,
		});

		component.handleInput("\x03");

		expect(onDone).toHaveBeenCalledTimes(1);
	});
});

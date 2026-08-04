import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";

export interface SkillLoadedSkillDetails {
	skillName: string;
	skillContent: string;
	skillPath: string;
}

export interface SkillLoadedDetails extends SkillLoadedSkillDetails {
	skills?: SkillLoadedSkillDetails[];
}

const SKILL_PREVIEW_LINES = 5;

export function renderSkillLoaded(
	message: { details?: SkillLoadedDetails },
	options: MessageRenderOptions,
	theme: Theme,
) {
	const container = new Container();
	if (!message.details) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("warning", "Skill loaded message is missing details."), 0, 0));
		return container;
	}

	const { skillName, skillContent, skillPath } = message.details;
	const skills = message.details.skills?.length
		? message.details.skills
		: [{ skillName, skillContent, skillPath }];
	container.addChild(new Spacer(1));

	const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
	const title = skills.length === 1
		? `Skill loaded: ${skills[0]!.skillName}`
		: `Skills loaded: ${skills.map((skill) => skill.skillName).join(", ")}`;
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
	box.addChild(new Text(skills.map((skill) => theme.fg("toolOutput", `   ${skill.skillPath}`)).join("\n"), 0, 0));
	box.addChild(new Spacer(1));

	const previewContent = skills.length === 1
		? skills[0]!.skillContent
		: skills.map((skill) => `<skill name="${skill.skillName}">\n${skill.skillContent}\n</skill>`).join("\n\n");
	const lines = previewContent.split("\n");
	if (options.expanded) {
		box.addChild(new Text(lines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0));
	} else {
		const previewLines = lines.slice(0, SKILL_PREVIEW_LINES);
		const remaining = lines.length - SKILL_PREVIEW_LINES;
		box.addChild(new Text(previewLines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0));
		if (remaining > 0) {
			box.addChild(new Text(theme.fg("warning", `\n... (${remaining} more lines)`), 0, 0));
		}
	}

	container.addChild(box);
	return container;
}

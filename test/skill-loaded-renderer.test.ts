import test from "node:test";
import assert from "node:assert/strict";
import { renderSkillLoaded } from "../skill-loaded-renderer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

test("renderSkillLoaded fails safe when message details are missing", () => {
	const rendered = renderSkillLoaded(
		{},
		{ expanded: false } as never,
		theme,
	);

	assert.ok(rendered);
});

test("renderSkillLoaded shows multiple names, paths, and skill blocks in one card", () => {
	const rendered = renderSkillLoaded(
		{
			details: {
				skillName: "tmux",
				skillContent: "Use tmux.",
				skillPath: "/skills/tmux/SKILL.md",
				skills: [
					{ skillName: "tmux", skillContent: "Use tmux.", skillPath: "/skills/tmux/SKILL.md" },
					{ skillName: "audit", skillContent: "Audit changes.", skillPath: "/skills/audit/SKILL.md" },
				],
			},
		},
		{ expanded: true } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /Skills loaded: tmux, audit/);
	assert.match(output, /\/skills\/tmux\/SKILL\.md/);
	assert.match(output, /\/skills\/audit\/SKILL\.md/);
	assert.match(output, /<skill name="tmux">/);
	assert.match(output, /<skill name="audit">/);
});

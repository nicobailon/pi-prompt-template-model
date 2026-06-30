import test from "node:test";
import assert from "node:assert/strict";
import { renderSkillLoaded } from "../skill-loaded-renderer.ts";

test("renderSkillLoaded fails safe when message details are missing", () => {
	const rendered = renderSkillLoaded(
		{},
		{ expanded: false } as never,
		{
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
	);

	assert.ok(rendered);
});

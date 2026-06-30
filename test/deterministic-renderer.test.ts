import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderDeterministicCompletion, renderDeterministicResult } from "../deterministic-renderer.ts";

const theme = {
	fg(_token: string, text: string) { return text; },
	bg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
} as Theme;

test("renderDeterministicResult fails safe when details are missing", () => {
	const rendered = renderDeterministicResult({}, { expanded: false } as never, theme);
	assert.ok(rendered);
});

test("renderDeterministicResult shows polished status and output labels", () => {
	const rendered = renderDeterministicResult(
		{
			details: {
				execution: { kind: "script", path: "./ship.sh", args: ["--fast"] },
				resolvedScriptPath: "/tmp/ship.sh",
				cwd: "/repo",
				nonInteractive: false,
				exitCode: 3,
				stdout: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9",
				stdoutTotalChars: 120,
				stdoutTotalLines: 9,
				stdoutTruncated: true,
				stderr: "boom\n",
				stderrTotalChars: 5,
				stderrTotalLines: 1,
				stderrTruncated: false,
				durationMs: 1250,
				timedOut: true,
			},
		},
		{ expanded: false } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /deterministic \| failed · exit 3 · 1\.3s/);
	assert.match(output, /command: '\/tmp\/ship\.sh' '--fast'/);
	assert.match(output, /script: \/tmp\/ship\.sh/);
	assert.match(output, /nonInteractive: false/);
	assert.match(output, /stdout · 9 lines · 120 chars · capped/);
	assert.match(output, /stderr · 1 line · 5 chars/);
	assert.match(output, /more lines hidden — Ctrl\+O to expand/);
	assert.match(output, /stored preview capped/);
	assert.match(output, /timeout reached before the process exited/);
});

test("renderDeterministicCompletion renders the no-handoff completion summary", () => {
	const rendered = renderDeterministicCompletion(
		{ details: { promptName: "push", exitCode: 0, timedOut: false, status: "succeeded" } },
		{ expanded: false } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /deterministic complete \| succeeded · exit 0/);
	assert.match(output, /prompt: push/);
	assert.match(output, /model handoff: skipped/);
});

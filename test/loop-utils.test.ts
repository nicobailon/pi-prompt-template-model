import test from "node:test";
import assert from "node:assert/strict";
import { didIterationMakeChanges, generateBoomerangSummary, generateChainStepSummary, generateIterationSummary, getIterationEntries } from "../loop-utils.ts";

const delegatedEntry = {
	id: "delegated-1",
	type: "custom_message",
	customType: "prompt-template-subagent",
	content: "Done",
	display: true,
	details: {
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/a.ts" } },
					{ type: "text", text: "Updated file." },
				],
			},
		],
		text: "Updated file.",
		changed: true,
	},
} as any;

const delegatedWorktreeEntry = {
	id: "delegated-2",
	type: "custom_message",
	customType: "prompt-template-subagent",
	content: "2/2 succeeded\n\n=== Worktree Changes ===\n\n--- Task 1 (simplifier): 1 file changed, +1 -0 ---",
	display: true,
	details: {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
			},
		],
		parallelResults: [
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Done." }],
					},
				],
			},
		],
		text: "2/2 succeeded\n\n=== Worktree Changes ===\n\n--- Task 1 (simplifier): 1 file changed, +1 -0 ---",
		changed: true,
	},
} as any;

test("didIterationMakeChanges detects delegated write/edit calls", () => {
	assert.equal(didIterationMakeChanges([delegatedEntry]), true);
});

test("generateIterationSummary includes delegated outcomes", () => {
	const summary = generateIterationSummary([delegatedEntry], "simplify", 1, 3);
	assert.match(summary, /modified src\/a\.ts/);
	assert.match(summary, /Outcome: Updated file\./);
});

test("generateBoomerangSummary labels collapsed prompt runs", () => {
	const summary = generateBoomerangSummary([delegatedEntry], "double-check");
	assert.match(summary, /^\[Boomerang\]/);
	assert.match(summary, /Task: "double-check"/);
	assert.match(summary, /Outcome: Updated file\./);
});

test("generateBoomerangSummary preserves full multiline outcomes", () => {
	const longText = `Line one\r\n${"x".repeat(520)}\nLine three`;
	const entries = [
		{
			id: "msg-long",
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: longText }],
			},
		},
	] as any;

	const boomerangSummary = generateBoomerangSummary(entries, "double-check");
	assert.match(boomerangSummary, /Outcome: Line one\n/);
	assert.match(boomerangSummary, /Line three$/);
	assert.doesNotMatch(boomerangSummary, /\.\.\.$/);

	const loopSummary = generateIterationSummary(entries, "double-check", 1, 2);
	assert.match(loopSummary, /\.\.\.$/);
	assert.doesNotMatch(loopSummary, /Outcome: Line one\n/);
});

test("getIterationEntries falls back to full branch when start is missing", () => {
	const branch = [{ id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }];
	const ctx = {
		sessionManager: {
			getBranch() {
				return branch as any;
			},
		},
	};
	assert.equal(getIterationEntries(ctx as any, null).length, 1);
	assert.equal(getIterationEntries(ctx as any, "missing").length, 1);
});

test("generateChainStepSummary includes ordinary assistant actions", () => {
	const entries = [
		{
			id: "msg-1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/a.ts" } },
					{ type: "toolCall", id: "2", name: "write", arguments: { path: "src/b.ts" } },
					{ type: "toolCall", id: "3", name: "bash", arguments: { command: "npm test" } },
					{ type: "text", text: "Applied fixes." },
				],
			},
		},
	] as any;

	const summary = generateChainStepSummary(entries, "review", 2);
	assert.match(summary, /^Step 2 — review:/);
	assert.match(summary, /Actions: read 1 file\(s\), modified src\/b\.ts, ran 1 command\(s\)\./);
	assert.match(summary, /Outcome: Applied fixes\./);
});

test("generateChainStepSummary includes delegated custom-message data", () => {
	const summary = generateChainStepSummary([delegatedEntry], "parallel(scan-fe, scan-be)", 1);
	assert.match(summary, /^Step 1 — parallel\(scan-fe, scan-be\):/);
	assert.match(summary, /Actions: modified src\/a\.ts\./);
	assert.match(summary, /Outcome: Updated file\./);
});

test("didIterationMakeChanges respects delegated changed flag for worktree-only results", () => {
	assert.equal(didIterationMakeChanges([delegatedWorktreeEntry]), true);
});

test("generateIterationSummary uses delegated aggregate text when present", () => {
	const summary = generateIterationSummary([delegatedWorktreeEntry], "simplify-parallel", 1, 2);
	assert.match(summary, /Outcome: 2\/2 succeeded .*=== Worktree Changes ===/);
});

test("generateChainStepSummary supports text-only steps without action lines", () => {
	const entries = [
		{
			id: "msg-2",
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "No edits required." }],
			},
		},
	] as any;

	const summary = generateChainStepSummary(entries, "summarize", 3);
	assert.match(summary, /^Step 3 — summarize:/);
	assert.doesNotMatch(summary, /^.*Actions:/m);
	assert.match(summary, /Outcome: No edits required\./);
});

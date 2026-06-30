import test from "node:test";
import assert from "node:assert/strict";
import { createDelegatedProgressWidget } from "../subagent-widget.ts";
import { clearDelegatedLiveState, updateDelegatedLiveState } from "../subagent-runtime.ts";

const theme = {
	fg(_token: string, text: string) { return text; },
	bg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

test("parallel delegated widget renders per-task models, tools, and output snippets", () => {
	const requestId = "widget-parallel-rich";
	clearDelegatedLiveState(requestId);
	updateDelegatedLiveState(requestId, {
		status: "running",
		toolCount: 5,
		tokens: 1200,
		taskProgress: [
			{
				index: 0,
				agent: "delegate",
				status: "running",
				model: "openai-codex/gpt-5.3-codex-spark",
				currentTool: "read",
				currentToolArgs: "README.md",
				recentTools: [{ tool: "bash", args: "git diff -- README.md" }],
				recentOutputLines: ["found compare section", "writing smoke test line"],
				toolCount: 2,
				tokens: 400,
			},
			{
				index: 1,
				agent: "delegate",
				status: "completed",
				model: "openai-codex/gpt-5.4-mini",
				recentTools: [{ tool: "edit", args: "README.md" }],
				recentOutputLines: ["done"],
				toolCount: 3,
				tokens: 800,
			},
		],
	});

	const widget = createDelegatedProgressWidget(
		requestId,
		"delegate",
		"fork",
		"do work",
		[
			{ agent: "delegate", task: "worker 1", model: "openai-codex/gpt-5.3-codex-spark" },
			{ agent: "delegate", task: "worker 2", model: "openai-codex/gpt-5.4-mini" },
		],
		theme,
	);

	const rendered = widget.render(120).join("\n");
	clearDelegatedLiveState(requestId);

	assert.match(rendered, /parallel 1\/2 running \[fork\] \| 5 tools, 1\.2k tok/);
	assert.match(rendered, /task 1 · delegate gpt-5\.3-codex-spark running/);
	assert.match(rendered, /> \[read: README\.md\]/);
	assert.match(rendered, /\$ git diff -- README\.md/);
	assert.match(rendered, /found compare section/);
	assert.match(rendered, /writing smoke test line/);
	assert.match(rendered, /task 2 · delegate gpt-5\.4-mini completed/);
	assert.match(rendered, /\[edit: README\.md\]/);
	assert.match(rendered, /done/);
});

test("parallel delegated widget rerenders when per-task output changes without status changes", () => {
	const requestId = "widget-parallel-rerender";
	clearDelegatedLiveState(requestId);
	updateDelegatedLiveState(requestId, {
		status: "running",
		taskProgress: [
			{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["line 1"] },
		],
	});

	const widget = createDelegatedProgressWidget(
		requestId,
		"delegate",
		"fresh",
		"do work",
		[{ agent: "delegate", task: "worker 1", model: "openai-codex/gpt-5.3-codex-spark" }],
		theme,
	);

	const first = widget.render(120).join("\n");
	updateDelegatedLiveState(requestId, {
		status: "running",
		taskProgress: [
			{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["line 1", "line 2"] },
		],
	});
	const second = widget.render(120).join("\n");
	clearDelegatedLiveState(requestId);

	assert.match(first, /line 1/);
	assert.doesNotMatch(first, /line 2/);
	assert.match(second, /line 2/);
});

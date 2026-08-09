import test from "node:test";
import assert from "node:assert/strict";
import {
	appendDelegatedLiveOutput,
	clearDelegatedLiveState,
	getDelegatedLiveState,
	updateDelegatedLiveState,
} from "../subagent-runtime.ts";

test("delegated live state updates and preserves existing fields", () => {
	const requestId = "request-live-state";
	clearDelegatedLiveState(requestId);

	updateDelegatedLiveState(requestId, {
		status: "running",
		toolCount: 1,
		recentOutput: ["first"],
	});
	updateDelegatedLiveState(requestId, {
		model: "anthropic/claude-sonnet-4",
	});

	const state = getDelegatedLiveState(requestId);
	assert.equal(state?.status, "running");
	assert.equal(state?.toolCount, 1);
	assert.deepEqual(state?.recentOutput, ["first"]);
	assert.equal(state?.model, "anthropic/claude-sonnet-4");

	state?.recentOutput.push("mutated snapshot");
	assert.deepEqual(getDelegatedLiveState(requestId)?.recentOutput, ["first"]);

	clearDelegatedLiveState(requestId);
	assert.equal(getDelegatedLiveState(requestId), undefined);
});

test("appendDelegatedLiveOutput skips empty and running placeholder lines", () => {
	const requestId = "request-output";
	clearDelegatedLiveState(requestId);

	appendDelegatedLiveOutput(requestId, "");
	appendDelegatedLiveOutput(requestId, "   ");
	appendDelegatedLiveOutput(requestId, "(running...)");
	appendDelegatedLiveOutput(requestId, "useful output");

	assert.deepEqual(getDelegatedLiveState(requestId)?.recentOutput, ["useful output"]);
	clearDelegatedLiveState(requestId);
});

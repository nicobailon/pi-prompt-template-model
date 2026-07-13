import test from "node:test";
import assert from "node:assert/strict";
import {
	extractChainContextFlag,
	extractLineupOverrides,
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	extractWorktreeFlag,
	parseCommandArgs,
	substituteArgs,
} from "../args.ts";

test("parseCommandArgs respects quoted segments", () => {
	assert.deepEqual(parseCommandArgs('alpha "two words" beta'), ["alpha", "two words", "beta"]);
	assert.deepEqual(parseCommandArgs("one 'two three' four"), ["one", "two three", "four"]);
});

test("substituteArgs supports positional, aggregate, and slice replacements", () => {
	const result = substituteArgs("$1 | $@ | $ARGUMENTS | ${@:2} | ${@:2:2}", ["one", "two", "three", "four"]);
	assert.equal(result, "one | one two three four | one two three four | two three four | two three");
});

test("substituteArgs is non-recursive", () => {
	const result = substituteArgs("$1 / $@", ["$2", "$ARGUMENTS"]);
	assert.equal(result, "$2 / $2 $ARGUMENTS");
});

test("substituteArgs supports @$ as alias for all args", () => {
	const result = substituteArgs("Args: @$", ["one", "two"]);
	assert.equal(result, "Args: one two");
});

test("extractLoopCount extracts --loop N and --loop=N forms", () => {
	assert.deepEqual(extractLoopCount("--loop 5"), { args: "", loopCount: 5, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop=5"), { args: "", loopCount: 5, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop 1"), { args: "", loopCount: 1, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop=999"), { args: "", loopCount: 999, fresh: false, converge: true });
});

test("extractLoopCount preserves surrounding quoted args", () => {
	assert.deepEqual(extractLoopCount('"fix auth bug" --loop 3'), { args: '"fix auth bug"', loopCount: 3, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("'fix auth bug' --loop=3"), { args: "'fix auth bug'", loopCount: 3, fresh: false, converge: true });
});

test("extractLoopCount handles chain-style args with -> and --", () => {
	const result = extractLoopCount('analyze -> fix --loop=3 -- "src/main.ts"');
	assert.ok(result);
	assert.equal(result.loopCount, 3);
	assert.equal(result.args, 'analyze -> fix  -- "src/main.ts"');
	assert.equal(result.converge, true);
});

test("extractLoopCount treats bare --loop as unlimited", () => {
	assert.deepEqual(extractLoopCount("--loop"), { args: "", loopCount: null, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop 5x"), { args: "5x", loopCount: null, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop -1"), { args: "-1", loopCount: null, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop --fresh"), { args: "", loopCount: null, fresh: true, converge: true });
	assert.deepEqual(extractLoopCount("--loop --no-converge"), { args: "", loopCount: null, fresh: false, converge: false });
});

test("extractLoopCount keeps quoted --loop as literal", () => {
	assert.equal(extractLoopCount('"--loop"'), null);
	assert.equal(extractLoopCount('"--loop" task'), null);
});

test("extractLoopCount treats invalid --loop numeric values as regular args", () => {
	assert.equal(extractLoopCount("--loop 0"), null);
	assert.equal(extractLoopCount("--loop 1000"), null);
	assert.equal(extractLoopCount("--loop=0"), null);
	assert.equal(extractLoopCount("--loop=1000"), null);
	assert.equal(extractLoopCount("--loop=abc"), null);
});

test("extractLoopCount allows bounded --loop with no-converge", () => {
	assert.deepEqual(extractLoopCount("--loop 5 --no-converge"), {
		args: "",
		loopCount: 5,
		fresh: false,
		converge: false,
	});
	assert.deepEqual(extractLoopCount("--loop 5 --fresh"), {
		args: "",
		loopCount: 5,
		fresh: true,
		converge: true,
	});
});

test("extractLoopCount removes repeated loop tokens and loop-adjacent flags", () => {
	assert.deepEqual(extractLoopCount("--loop 2 --loop 3 task --fresh --fresh --no-converge --no-converge"), {
		args: "task",
		loopCount: 2,
		fresh: true,
		converge: false,
	});
	assert.deepEqual(extractLoopCount("--loop 0 --loop 2 task"), {
		args: "task",
		loopCount: 2,
		fresh: false,
		converge: true,
	});
});

test("extractLoopCount handles newline-separated flags", () => {
	assert.deepEqual(extractLoopCount("task\n--loop 3\n--fresh"), {
		args: "task",
		loopCount: 3,
		fresh: true,
		converge: true,
	});
});

test("extractLoopCount returns null when no loop token exists", () => {
	assert.equal(extractLoopCount("regular args"), null);
	assert.equal(extractLoopCount(""), null);
	assert.equal(extractLoopCount("5x"), null);
	assert.equal(extractLoopCount("3x task"), null);
});

test("extractLoopCount ignores --fresh and --no-converge without --loop", () => {
	assert.equal(extractLoopCount("--fresh"), null);
	assert.equal(extractLoopCount("task --fresh"), null);
	assert.equal(extractLoopCount("--no-converge"), null);
	assert.equal(extractLoopCount("task --no-converge"), null);
});

test("extractLoopCount composes with parseCommandArgs and substituteArgs", () => {
	const loop = extractLoopCount('"focus on performance" --loop 3');
	assert.ok(loop);
	const args = parseCommandArgs(loop.args);
	assert.equal(substituteArgs("Review: $@", args), "Review: focus on performance");
});

test("extractLoopFlags removes unquoted --fresh and --no-converge", () => {
	assert.deepEqual(extractLoopFlags("--fresh task --no-converge --fresh"), {
		args: "task",
		fresh: true,
		converge: false,
	});
});

test("extractLoopFlags preserves quoted flags", () => {
	assert.deepEqual(extractLoopFlags('"--fresh" \'--no-converge\' --fresh'), {
		args: '"--fresh" \'--no-converge\'',
		fresh: true,
		converge: true,
	});
});

test("extractLoopFlags defaults when no flags are present", () => {
	assert.deepEqual(extractLoopFlags("regular args"), {
		args: "regular args",
		fresh: false,
		converge: true,
	});
});

test("extractLoopFlags composes with parseCommandArgs and substituteArgs", () => {
	const flags = extractLoopFlags('--fresh "focus on performance"');
	assert.equal(flags.fresh, true);
	assert.equal(flags.converge, true);
	const args = parseCommandArgs(flags.args);
	assert.equal(substituteArgs("Review: $@", args), "Review: focus on performance");
});

test("extractLoopFlags extracts --no-converge and removes all occurrences", () => {
	assert.deepEqual(extractLoopFlags("--no-converge task --no-converge"), {
		args: "task",
		fresh: false,
		converge: false,
	});
});

test("extractLoopFlags handles newline-separated flags", () => {
	assert.deepEqual(extractLoopFlags("task\n--fresh\r\n--no-converge"), {
		args: "task",
		fresh: true,
		converge: false,
	});
});

test("extractChainContextFlag strips bare --chain-context tokens", () => {
	assert.deepEqual(extractChainContextFlag("task --chain-context"), {
		args: "task",
		chainContext: true,
	});
});

test("extractChainContextFlag strips repeated flags", () => {
	assert.deepEqual(extractChainContextFlag("--chain-context task --chain-context"), {
		args: "task",
		chainContext: true,
	});
});

test("extractChainContextFlag preserves quoted flags", () => {
	const extracted = extractChainContextFlag('"--chain-context" --chain-context task');
	assert.equal(extracted.chainContext, true);
	assert.deepEqual(parseCommandArgs(extracted.args), ["--chain-context", "task"]);
});

test("extractChainContextFlag composes with chain-style args and shared args separator", () => {
	assert.deepEqual(extractChainContextFlag('analyze -> fix --chain-context -- "src/main.ts"'), {
		args: 'analyze -> fix  -- "src/main.ts"',
		chainContext: true,
	});
});

test("extractWorktreeFlag strips bare tokens and preserves quoted values", () => {
	assert.deepEqual(extractWorktreeFlag("parallel(scan,review) --worktree"), {
		args: "parallel(scan,review)",
		worktree: true,
	});
	assert.deepEqual(extractWorktreeFlag("--worktree chain-a -> chain-b --worktree"), {
		args: "chain-a -> chain-b",
		worktree: true,
	});
	const extracted = extractWorktreeFlag('"--worktree" parallel(scan,review) --worktree');
	assert.equal(extracted.worktree, true);
	assert.deepEqual(parseCommandArgs(extracted.args), ["--worktree", "parallel(scan,review)"]);
});

test("extractSubagentOverride parses bare and named runtime overrides", () => {
	assert.deepEqual(extractSubagentOverride("--subagent task"), {
		args: "task",
		override: { enabled: true },
	});
	assert.deepEqual(extractSubagentOverride("task --subagent:worker"), {
		args: "task",
		override: { enabled: true, agent: "worker" },
	});
	assert.deepEqual(extractSubagentOverride("task --subagent=reviewer"), {
		args: "task",
		override: { enabled: true, agent: "reviewer" },
	});
});

test("extractSubagentOverride ignores quoted flags and strips repeated overrides", () => {
	assert.deepEqual(extractSubagentOverride('"--subagent" task'), {
		args: '"--subagent" task',
	});
	assert.deepEqual(extractSubagentOverride("task --subagent --subagent:worker"), {
		args: "task",
		override: { enabled: true, agent: "worker" },
	});
});

test("extractSubagentOverride extracts --cwd and strips it from args", () => {
	assert.deepEqual(extractSubagentOverride("--cwd=/tmp/nfd task"), {
		args: "task",
		cwd: "/tmp/nfd",
	});
	assert.deepEqual(extractSubagentOverride("task --subagent=reviewer --cwd=/tmp/nfd"), {
		args: "task",
		override: { enabled: true, agent: "reviewer" },
		cwd: "/tmp/nfd",
	});
});

test("extractSubagentOverride handles quoted, empty, and repeated --cwd flags", () => {
	assert.deepEqual(extractSubagentOverride('"--cwd=/tmp" task'), {
		args: '"--cwd=/tmp" task',
	});
	assert.deepEqual(extractSubagentOverride("task --cwd="), {
		args: "task",
	});
	assert.deepEqual(extractSubagentOverride("task --cwd=/tmp/one --cwd=/tmp/two"), {
		args: "task",
		cwd: "/tmp/two",
	});
});

test("extractSubagentOverride extracts --model and strips it from args", () => {
	assert.deepEqual(extractSubagentOverride("--model=anthropic/claude-opus-4-6 task"), {
		args: "task",
		model: "anthropic/claude-opus-4-6",
	});
	assert.deepEqual(extractSubagentOverride("task --subagent --model=openai/gpt-5.4"), {
		args: "task",
		override: { enabled: true },
		model: "openai/gpt-5.4",
	});
});

test("extractSubagentOverride ignores empty --model= and quoted --model", () => {
	assert.deepEqual(extractSubagentOverride("task --model="), {
		args: "task",
	});
	assert.deepEqual(extractSubagentOverride('"--model=anthropic/opus" task'), {
		args: '"--model=anthropic/opus" task',
	});
});

test("extractSubagentOverride extracts --fork and implies --subagent", () => {
	assert.deepEqual(extractSubagentOverride("task --fork"), {
		args: "task",
		override: { enabled: true },
		fork: true,
	});
	assert.deepEqual(extractSubagentOverride("task --fork --subagent:worker"), {
		args: "task",
		override: { enabled: true, agent: "worker" },
		fork: true,
	});
});

test("extractSubagentOverride preserves quoted --fork", () => {
	assert.deepEqual(extractSubagentOverride('"--fork" task'), {
		args: '"--fork" task',
	});
});

test("extractLineupOverrides parses worker/reviewer/final-applier slot aliases for unquoted and quoted JSON payloads", () => {
	const cases = [
		{
			input: 'task --workers=[{"subagent":true,"count":3},{"subagent":"delegate","model":"openai/gpt-5.4","taskSuffix":"save to notes.md"}] --reviewers-append=[{"subagent":true,"cwd":"/tmp/repo","count":2}]',
			expected: [
				{
					target: "workers",
					mode: "replace",
					slots: [
						{ agent: "delegate", count: 3 },
						{ agent: "delegate", model: "openai/gpt-5.4", taskSuffix: "save to notes.md" },
					],
				},
				{
					target: "reviewers",
					mode: "append",
					slots: [{ agent: "reviewer", cwd: "/tmp/repo", count: 2 }],
				},
			],
		},
		{
			input: 'task --workers=[{"subagent":true, "task":"fix bug", "taskSuffix":"write findings"}, {"agent":"delegate","model":"openai/gpt-5.4"}] --reviewers=[{"subagent":true, "task":"rank variants", "count":2}]',
			expected: [
				{
					target: "workers",
					mode: "replace",
					slots: [
						{ agent: "delegate", task: "fix bug", taskSuffix: "write findings" },
						{ agent: "delegate", model: "openai/gpt-5.4" },
					],
				},
				{
					target: "reviewers",
					mode: "replace",
					slots: [{ agent: "reviewer", task: "rank variants", count: 2 }],
				},
			],
		},
		{
			input: `task --workers='[{"subagent":true,"task":"fix bug"}]' --reviewers-append='[{"subagent":true}]'`,
			expected: [
				{
					target: "workers",
					mode: "replace",
					slots: [{ agent: "delegate", task: "fix bug" }],
				},
				{
					target: "reviewers",
					mode: "append",
					slots: [{ agent: "reviewer" }],
				},
			],
		},
		{
			input: 'task --final-applier={"subagent":true,"model":"openai-codex/gpt-5.4:low","taskSuffix":"Prefer merge plans when they beat any single worker."}',
			expected: [
				{
					target: "finalApplier",
					mode: "replace",
					slots: [{ agent: "delegate", model: "openai-codex/gpt-5.4", thinking: "low", taskSuffix: "Prefer merge plans when they beat any single worker." }],
				},
			],
		},
	] as const;

	for (const testCase of cases) {
		const extracted = extractLineupOverrides(testCase.input);
		assert.equal(extracted.args, "task");
		assert.equal(extracted.errors.length, 0);
		assert.deepEqual(extracted.actions, testCase.expected);
	}
});

test("extractLineupOverrides reports invalid slot payloads and strips known flags", () => {
	const cases = [
		{
			input: 'task --workers=not-json --reviewers=[{"subagent":false}]',
			errorCount: 2,
			patterns: [/valid JSON/, /requires "subagent" to be true or a non-empty string/],
		},
		{
			input: 'task --workers=[{"agent":"delegate","subagent":true}]',
			errorCount: 1,
			patterns: [/cannot combine "agent" and "subagent"/],
		},
		{
			input: 'task --workers=[{"agent":"delegate","count":"2"}] --reviewers=[{"subagent":true,"count":0}]',
			errorCount: 2,
			patterns: [/"count" must be an integer greater than or equal to 1/, /"count" must be an integer greater than or equal to 1/],
		},
		{
			input: 'task --final-applier=[{"subagent":true},{"subagent":true}]',
			errorCount: 1,
			patterns: [/one-element JSON array/],
		},
		{
			input: 'task --final-applier={"subagent":true,"count":2}',
			errorCount: 1,
			patterns: [/"count" is not supported/],
		},
		{
			input: 'task --final-applier={"subagent":true,"cwd":"/tmp/repo"}',
			errorCount: 1,
			patterns: [/"cwd" is not supported/],
		},
		{
			input: 'task --final-applier={"subagent":true,"cwd":123}',
			errorCount: 1,
			patterns: [/"cwd" is not supported/],
		},
	] as const;

	for (const testCase of cases) {
		const extracted = extractLineupOverrides(testCase.input);
		assert.equal(extracted.args, "task");
		assert.equal(extracted.actions.length, 0);
		assert.equal(extracted.errors.length, testCase.errorCount);
		for (let i = 0; i < testCase.patterns.length; i++) {
			assert.match(extracted.errors[i] ?? "", testCase.patterns[i]);
		}
	}
});

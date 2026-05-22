import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptCommandDescription, loadPromptsWithModel, RESERVED_COMMAND_NAMES, resolveSkillPath } from "../prompt-loader.js";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadPromptsWithModel keeps the first same-layer duplicate after lexical sorting", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "alpha"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "zeta"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "alpha", "dup.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nalpha');
		writeFileSync(join(cwd, ".pi", "prompts", "zeta", "dup.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nzeta');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("dup")?.content, "alpha");
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /conflicts with/);
	});
});

test("loadPromptsWithModel lets project prompts override user prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "prompts", "same.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nuser');
		writeFileSync(join(cwd, ".pi", "prompts", "same.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nproject');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("same")?.source, "project");
		assert.equal(result.prompts.get("same")?.content, "project");
	});
});

test("loadPromptsWithModel loads prompt directories from global and project settings", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "external-prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "project-prompts"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "settings.json"), JSON.stringify({ prompts: ["external-prompts"] }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ prompts: ["project-prompts"] }));
		writeFileSync(join(root, ".pi", "agent", "external-prompts", "user-settings.md"), '---\nthinking: medium\n---\nuser');
		writeFileSync(join(cwd, ".pi", "project-prompts", "project-settings.md"), '---\nthinking: high\n---\nproject');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("user-settings")?.source, "user");
		assert.equal(result.prompts.get("user-settings")?.thinking, "medium");
		assert.equal(result.prompts.get("project-settings")?.source, "project");
		assert.equal(result.prompts.get("project-settings")?.thinking, "high");
	});
});

test("loadPromptsWithModel expands tilde settings prompt paths", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, "commands"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "settings.json"), JSON.stringify({ prompts: ["~/commands"] }));
		writeFileSync(join(root, "commands", "tilde-prompt.md"), '---\nthinking: low\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("tilde-prompt")?.thinking, "low");
	});
});

test("loadPromptsWithModel loads single prompt files from settings without sibling files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "commands"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ prompts: ["commands/only.md"] }));
		writeFileSync(join(cwd, ".pi", "commands", "only.md"), '---\nthinking: high\n---\nonly');
		writeFileSync(join(cwd, ".pi", "commands", "sibling.md"), '---\nthinking: medium\n---\nsibling');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("only")?.content, "only");
		assert.equal(result.prompts.has("sibling"), false);
	});
});

test("loadPromptsWithModel dedupes overlapping settings prompt paths by canonical file", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ prompts: ["prompts"] }));
		writeFileSync(join(promptsDir, "same.md"), '---\nthinking: medium\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("same")?.thinking, "medium");
		assert.doesNotMatch(result.diagnostics.map((item) => item.message).join("\n"), /conflicts with/);
	});
});

test("loadPromptsWithModel skips reserved command names and surfaces diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "model.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nhello');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("model"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /reserved/);
	});
});

test("loadPromptsWithModel uses canonical frontmatter parsing for booleans and warns on invalid thinking", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "debug.md"),
			'---\nmodel: claude-sonnet-4-20250514\nrestore: false\nthinking: turbo\ndescription: "Debug prompt"\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("debug")?.restore, false);
		assert.equal(result.prompts.get("debug")?.description, "Debug prompt");
		assert.equal(result.prompts.get("debug")?.thinking, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid thinking level/i);
	});
});

test("loadPromptsWithModel trims optional string frontmatter fields", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "trimmed.md"),
			'---\nmodel: claude-sonnet-4-20250514\ndescription: "  Trim me  "\nskill: "  tmux  "\nthinking: " high "\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("trimmed")?.description, "Trim me");
		assert.equal(result.prompts.get("trimmed")?.skill, "tmux");
		assert.equal(result.prompts.get("trimmed")?.thinking, "high");
	});
});

test("loadPromptsWithModel allows non-chain prompts without model and defaults description to current", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inherit.md"), '---\ndescription: "inherit"\nskill: tmux\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("inherit");
		assert.ok(prompt);
		assert.deepEqual(prompt.models, []);
		assert.equal(buildPromptCommandDescription(prompt), "inherit [current +tmux] (project)");
	});
});

test("loadPromptsWithModel ignores generic prompts without model or extension features", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), '---\ndescription: "plain prompt"\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("review"), false);
	});
});

test("loadPromptsWithModel can include plain prompts for chain resolution without changing default loading", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), '---\ndescription: "plain prompt"\n---\nbody');

		const defaultResult = loadPromptsWithModel(cwd);
		const chainResult = loadPromptsWithModel(cwd, true);

		assert.equal(defaultResult.prompts.has("review"), false);
		assert.equal(chainResult.prompts.get("review")?.content, "body");
		assert.deepEqual(chainResult.prompts.get("review")?.models, []);
	});
});

test("loadPromptsWithModel keeps model-less prompts that use inline model conditionals", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "conditional.md"), '---\ndescription: "conditional"\n---\n<if-model is="anthropic/*">yes</if-model>');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("conditional"), true);
	});
});

test("loadPromptsWithModel keeps model-less prompts containing invalid conditional closers", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-conditional.md"), '---\ndescription: "bad conditional"\n---\n</else>');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-conditional"), true);
	});
});

test("loadPromptsWithModel ignores model-less prompts with restore-only config", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "restore-only.md"), '---\ndescription: "restore only"\nrestore: false\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("restore-only"), false);
	});
});

test("loadPromptsWithModel ignores model-less prompts with only invalid extension flags", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invalid-loop-only.md"), '---\ndescription: "invalid loop only"\nloop: 0\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("invalid-loop-only"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid loop value/i);
	});
});

test("loadPromptsWithModel still rejects explicitly empty model declarations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-empty.md"), '---\nmodel: "   "\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-empty"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter field "model" is empty/i);
	});
});

test("loadPromptsWithModel rejects invalid model declarations up front", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad.md"), '---\nmodel: anthropic/*\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel accepts provider-qualified model specs with additional slashes in model ids", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "nested-model.md"), '---\nmodel: openrouter/openai/gpt-5.4\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("nested-model"), true);
		assert.deepEqual(result.prompts.get("nested-model")?.models, ["openrouter/openai/gpt-5.4"]);
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel accepts nested provider-qualified model specs in bestOfN lineups", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "compare-nested-model.md"),
			[
				"---",
				"bestOfN:",
				"  workers:",
				"    - model: openrouter/openai/gpt-5.4",
				"  reviewers:",
				"    - model: openrouter/openai/gpt-5.4",
				"  finalApplier:",
				"    model: openrouter/openai/gpt-5.4",
				"---",
				"$@",
			].join("\n"),
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("compare-nested-model");
		assert.ok(prompt);
		assert.equal(prompt.workers?.[0]?.model, "openrouter/openai/gpt-5.4");
		assert.equal(prompt.reviewers?.[0]?.model, "openrouter/openai/gpt-5.4");
		assert.equal(prompt.finalApplier?.model, "openrouter/openai/gpt-5.4");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel rejects model declarations with internal whitespace", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-space.md"), '---\nmodel: anthropic /claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-space"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel rejects provider-qualified model specs with empty path segments", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-leading-slash.md"), '---\nmodel: /model\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-empty-model-id.md"), '---\nmodel: provider/\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-double-slash.md"), '---\nmodel: openrouter//gpt\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-trailing-slash.md"), '---\nmodel: openrouter/gpt/\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-leading-slash"), false);
		assert.equal(result.prompts.has("bad-empty-model-id"), false);
		assert.equal(result.prompts.has("bad-double-slash"), false);
		assert.equal(result.prompts.has("bad-trailing-slash"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel avoids recursive symlink loops", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(join(promptsDir, "nested"), { recursive: true });
		writeFileSync(join(promptsDir, "nested", "ok.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nbody');
		symlinkSync(promptsDir, join(promptsDir, "nested", "loop"));

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("ok")?.content, "body");
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /already visited prompt directory/i);
	});
});

test("loadPromptsWithModel rejects non-object frontmatter roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-frontmatter.md"), '---\n- model\n- claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-frontmatter"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter must be a key-value object/i);
	});
});

test("loadPromptsWithModel parses fresh frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), '---\nmodel: claude-sonnet-4-20250514\nfresh: true\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "normal.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deslop")?.fresh, true);
		assert.equal(result.prompts.get("normal")?.fresh, undefined);
	});
});

test("loadPromptsWithModel parses boomerang frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "review"\nboomerang: true\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("double-check");
		assert.equal(prompt?.boomerang, true);
		assert.equal(buildPromptCommandDescription(prompt!), "review [current boomerang] (project)");
	});
});

test("loadPromptsWithModel rejects boomerang on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-boomerang.md"), '---\nchain: "analyze -> fix"\nboomerang: true\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-boomerang");
		assert.ok(prompt);
		assert.equal(prompt.boomerang, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /chain" and "boomerang" cannot be combined/i);
	});
});

test("loadPromptsWithModel parses rotate frontmatter field on non-chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "rotate.md"), "---\nmodel: claude-sonnet-4-20250514\nrotate: true\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("rotate")?.rotate, true);
	});
});

test("loadPromptsWithModel ignores rotate on chain templates without diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-rotate.md"), '---\nchain: "analyze -> fix"\nrotate: true\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-rotate");
		assert.ok(prompt);
		assert.equal(prompt.rotate, undefined);
		assert.doesNotMatch(result.diagnostics.map((item) => item.message).join("\n"), /invalid rotate/i);
	});
});

test("loadPromptsWithModel stores comma-separated thinking levels when rotate model count matches", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5, claude-haiku-4-5\nrotate: true\nthinking: high, xhigh, off\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-thinking");
		assert.ok(prompt);
		assert.deepEqual(prompt.thinkingLevels, ["high", "xhigh", "off"]);
		assert.equal(prompt.thinking, undefined);
	});
});

test("loadPromptsWithModel diagnoses mismatched comma-separated thinking levels for rotate prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking-mismatch.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5\nrotate: true\nthinking: high, xhigh, off\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-thinking-mismatch");
		assert.ok(prompt);
		assert.equal(prompt.thinkingLevels, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /expected 2 entries to match frontmatter field "model"/i);
	});
});

test("loadPromptsWithModel diagnoses invalid comma-separated thinking levels for rotate prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking-invalid.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5\nrotate: true\nthinking: high, turbo\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-thinking-invalid");
		assert.ok(prompt);
		assert.equal(prompt.thinkingLevels, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid thinking level/i);
	});
});

test("loadPromptsWithModel parses numeric loop frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: 5\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deslop")?.loop, 5);
	});
});

test("loadPromptsWithModel parses string loop frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), '---\nmodel: claude-sonnet-4-20250514\nloop: "7"\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deslop")?.loop, 7);
	});
});

test("loadPromptsWithModel diagnoses and ignores invalid loop frontmatter values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-loop.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: 0\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("bad-loop")?.loop, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid loop value/i);
	});
});

test("loadPromptsWithModel parses loop: unlimited as null", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "unlimited.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: unlimited\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("unlimited")?.loop, null);
	});
});

test("loadPromptsWithModel parses loop: true as null (unlimited)", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "unlimited.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: true\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("unlimited")?.loop, null);
	});
});

test("buildPromptCommandDescription shows loop:unlimited for unlimited loop", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "unlimited.md"), '---\nmodel: claude-sonnet-4-20250514\nloop: unlimited\ndescription: "test"\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("unlimited");
		assert.ok(prompt);
		assert.match(buildPromptCommandDescription(prompt), /loop:unlimited/);
	});
});

test("loadPromptsWithModel normalizes converge frontmatter values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "converge-true.md"), "---\nmodel: claude-sonnet-4-20250514\nconverge: true\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "converge-false.md"), "---\nmodel: claude-sonnet-4-20250514\nconverge: false\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "converge-invalid.md"), "---\nmodel: claude-sonnet-4-20250514\nconverge: maybe\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("converge-true")?.converge, undefined);
		assert.equal(result.prompts.get("converge-false")?.converge, false);
		assert.equal(result.prompts.get("converge-invalid")?.converge, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /default converge=true/i);
	});
});

test("loadPromptsWithModel loads chain templates without model and description shows chain metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "review-and-clean.md"),
			'---\nchain: "double-check --loop 2 -> deslop --loop 2"\ndescription: "Review then clean up slop"\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("review-and-clean");
		assert.ok(prompt);
		assert.equal(prompt.models.length, 0);
		assert.equal(prompt.chain, "double-check --loop 2 -> deslop --loop 2");
		assert.equal(buildPromptCommandDescription(prompt), "Review then clean up slop [chain: double-check --loop 2 -> deslop --loop 2] (project)");
	});
});

test("loadPromptsWithModel ignores model/thinking/skill fields on chain templates without diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-ignore.md"),
			'---\nchain: "analyze -> fix"\nmodel: 123\nthinking: turbo\nskill: 42\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-ignore");
		assert.ok(prompt);
		assert.equal(prompt.chain, "analyze -> fix");
		assert.equal(prompt.models.length, 0);
		assert.equal(prompt.thinking, undefined);
		assert.equal(prompt.skill, undefined);

		const diagnosticText = result.diagnostics.map((item) => item.message).join("\n");
		assert.doesNotMatch(diagnosticText, /invalid model|empty model|invalid thinking|invalid skill/i);
	});
});

test("loadPromptsWithModel stores loop/fresh/converge frontmatter on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-flags.md"),
			'---\nchain: "analyze -> fix"\nloop: 3\nfresh: true\nconverge: false\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-flags");
		assert.ok(prompt);
		assert.equal(prompt.chain, "analyze -> fix");
		assert.equal(prompt.loop, 3);
		assert.equal(prompt.fresh, true);
		assert.equal(prompt.converge, false);
	});
});

test("loadPromptsWithModel stores chainContext summary on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-context.md"),
			'---\nchain: "analyze -> fix"\nchainContext: summary\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-context");
		assert.ok(prompt);
		assert.equal(prompt.chainContext, "summary");
	});
});

test("loadPromptsWithModel diagnoses invalid chainContext on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-context-invalid.md"),
			'---\nchain: "analyze -> fix"\nchainContext: full\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-context-invalid");
		assert.ok(prompt);
		assert.equal(prompt.chainContext, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter field "chainContext" must be "summary"/i);
	});
});

test("buildPromptCommandDescription includes chain summary context label", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-context-description.md"),
			'---\nchain: "analyze -> fix"\nchainContext: summary\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-context-description");
		assert.ok(prompt);
		assert.equal(buildPromptCommandDescription(prompt), "[chain: analyze -> fix summary] (project)");
	});
});

test("loadPromptsWithModel diagnoses invalid chain frontmatter values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-number.md"), "---\nmodel: claude-sonnet-4-20250514\nchain: 123\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "chain-empty.md"), '---\nmodel: claude-sonnet-4-20250514\nchain: "   "\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const diagnosticText = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnosticText, /frontmatter field "chain" must be a string/i);
		assert.match(diagnosticText, /frontmatter field "chain" must be a non-empty string/i);
	});
});

test("loadPromptsWithModel rejects invalid parallel() chain declarations in frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "parallel-empty.md"), '---\nchain: "parallel() -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "parallel-nested.md"), '---\nchain: "parallel(scan, parallel(review))"\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("parallel-empty"), false);
		assert.equal(result.prompts.has("parallel-nested"), false);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /invalid chain declaration segment/i);
	});
});

test("loadPromptsWithModel accepts single-item parallel() declarations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "parallel-single.md"), '---\nchain: "parallel(scan-fe)"\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("parallel-single")?.chain, "parallel(scan-fe)");
	});
});

test("buildPromptCommandDescription includes loop metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "deslop.md"),
			'---\nmodel: claude-sonnet-4-20250514\ndescription: "Deslop"\nskill: tmux\nloop: 5\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("deslop");
		assert.ok(prompt);
		assert.equal(buildPromptCommandDescription(prompt), "Deslop [claude-sonnet-4-20250514 +tmux loop:5] (project)");
	});
});

test("buildPromptCommandDescription includes rotate and comma-separated thinking levels", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-description.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5\nrotate: true\nthinking: high, xhigh\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-description");
		assert.ok(prompt);
		assert.equal(buildPromptCommandDescription(prompt), "[claude-sonnet-4-20250514|claude-opus-4-5 rotate high,xhigh] (project)");
	});
});

test("loadPromptsWithModel parses subagent and inheritContext frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "delegated.md"),
			'---\nmodel: claude-sonnet-4-20250514\nsubagent: worker\ninheritContext: true\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("delegated");
		assert.ok(prompt);
		assert.equal(prompt.subagent, "worker");
		assert.equal(prompt.inheritContext, true);
		assert.match(buildPromptCommandDescription(prompt), /subagent:worker/);
		assert.match(buildPromptCommandDescription(prompt), /fork/);
	});
});

test("loadPromptsWithModel rejects invalid inheritContext combinations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-delegated.md"), '---\nchain: worker\nsubagent: true\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "inherit-only.md"), '---\nmodel: claude-sonnet-4-20250514\ninheritContext: true\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("chain-delegated")?.subagent, undefined);
		assert.equal(result.prompts.get("inherit-only")?.inheritContext, undefined);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /cannot be combined/i);
		assert.match(diagnostics, /requires "subagent"/i);
	});
});

test("loadPromptsWithModel stores cwd for delegated prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "delegated-cwd.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: /tmp/nfd\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("delegated-cwd");
		assert.ok(prompt);
		assert.equal(prompt.cwd, "/tmp/nfd");
	});
});

test("loadPromptsWithModel ignores cwd without subagent or chain", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-no-subagent.md"),
			"---\nmodel: claude-sonnet-4-20250514\ncwd: /tmp/nfd\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-no-subagent");
		assert.ok(prompt);
		assert.equal(prompt.cwd, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter field "cwd" requires "subagent"/i);
	});
});

test("loadPromptsWithModel rejects non-absolute cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-relative.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: relative/path\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-relative");
		assert.ok(prompt);
		assert.equal(prompt.cwd, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /must be an absolute path/i);
	});
});

test("loadPromptsWithModel rejects non-string cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-number.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: 123\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-number");
		assert.ok(prompt);
		assert.equal(prompt.cwd, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /expected a string/i);
	});
});

test("loadPromptsWithModel expands tilde-prefixed cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-tilde.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: ~/project\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-tilde");
		assert.ok(prompt);
		assert.equal(prompt.cwd, join(root, "project"));
	});
});

test("loadPromptsWithModel stores cwd on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-cwd.md"),
			'---\nchain: "analyze -> fix"\ncwd: /tmp/nfd\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-cwd");
		assert.ok(prompt);
		assert.equal(prompt.cwd, "/tmp/nfd");
		assert.equal(buildPromptCommandDescription(prompt), "[chain: analyze -> fix cwd:/tmp/nfd] (project)");
	});
});

test("resolveSkillPath searches project .pi, ancestor .agents, then global skills", () => {
	withTempHome((root) => {
		const repoRoot = join(root, "repo");
		const cwd = join(repoRoot, "apps", "web");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, ".agents", "skills", "from-agents"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "from-global"), { recursive: true });
		writeFileSync(join(repoRoot, ".agents", "skills", "from-agents", "SKILL.md"), "agents skill");
		writeFileSync(join(cwd, ".pi", "skills", "from-project.md"), "project skill");
		writeFileSync(join(root, ".pi", "agent", "skills", "from-global", "SKILL.md"), "global skill");

		assert.equal(resolveSkillPath("from-project", cwd), join(cwd, ".pi", "skills", "from-project.md"));
		assert.equal(resolveSkillPath("from-agents", cwd), join(repoRoot, ".agents", "skills", "from-agents", "SKILL.md"));
		assert.equal(resolveSkillPath("from-global", cwd), join(root, ".pi", "agent", "skills", "from-global", "SKILL.md"));
	});
});

test("resolveSkillPath falls back to ~/.agents/skills", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		writeFileSync(join(root, ".agents", "skills", "from-legacy.md"), "legacy skill");

		assert.equal(resolveSkillPath("from-legacy", cwd), join(root, ".agents", "skills", "from-legacy.md"));
	});
});

test("loadPromptsWithModel validates parallel/worktree frontmatter combinations", () => {
	withTempHome((root) => {
		const cases = [
			{
				name: "parallel-review",
				content: '---\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\ninheritContext: true\nparallel: 3\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("parallel-review");
					assert.ok(prompt);
					assert.equal(prompt.parallel, 3);
					assert.equal(prompt.subagent, "simplifier");
					assert.equal(prompt.inheritContext, true);
					assert.equal(result.diagnostics.filter((d) => d.message.includes("parallel")).length, 0);
				},
			},
			{
				name: "bad-parallel",
				content: '---\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\nparallel: 1\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-parallel");
					assert.ok(prompt);
					assert.equal(prompt.parallel, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("parallel") && d.message.includes("greater than or equal to 2")));
				},
			},
			{
				name: "plain-parallel",
				content: '---\nmodel: claude-sonnet-4-20250514\nparallel: 3\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("plain-parallel");
					assert.ok(prompt);
					assert.equal(prompt.parallel, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("parallel") && d.message.includes('requires "subagent"')));
				},
			},
			{
				name: "chain-parallel-field",
				content: '---\nchain: "review -> fix"\nparallel: 3\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("chain-parallel-field");
					assert.ok(prompt);
					assert.equal(prompt.parallel, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("parallel") && d.message.includes('cannot be combined with "chain"')));
				},
			},
			{
				name: "parallel-worktree",
				content: '---\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\nparallel: 3\nworktree: true\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("parallel-worktree");
					assert.ok(prompt);
					assert.equal(prompt.parallel, 3);
					assert.equal(prompt.worktree, true);
					assert.equal(result.diagnostics.filter((d) => d.message.includes("worktree")).length, 0);
				},
			},
			{
				name: "parallel-desc",
				content: '---\ndescription: "Parallel simplify"\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\nparallel: 3\nworktree: true\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("parallel-desc");
					assert.ok(prompt);
					const desc = buildPromptCommandDescription(prompt);
					assert.match(desc, /parallel:3/);
					assert.match(desc, /subagent:simplifier/);
					assert.match(desc, /worktree/);
				},
			},
			{
				name: "wt-pipeline",
				content: '---\nchain: "parallel(scan-fe, scan-be) -> review"\nworktree: true\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("wt-pipeline");
					assert.ok(prompt);
					assert.equal(prompt.worktree, true);
					assert.equal(result.diagnostics.filter((d) => d.message.includes("worktree")).length, 0);
				},
			},
			{
				name: "plain",
				content: '---\nmodel: claude-sonnet-4-20250514\nworktree: true\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("plain");
					assert.ok(prompt);
					assert.equal(prompt.worktree, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("worktree") && d.message.includes("requires")));
				},
			},
			{
				name: "seq-chain",
				content: '---\nchain: "analyze -> fix"\nworktree: true\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("seq-chain");
					assert.ok(prompt);
					assert.equal(prompt.worktree, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("worktree") && d.message.includes("parallel")));
				},
			},
			{
				name: "bad-wt",
				content: '---\nchain: "parallel(a, b) -> c"\nworktree: 42\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-wt");
					assert.ok(prompt);
					assert.equal(prompt.worktree, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("worktree") && d.message.includes("must be true or false")));
				},
			},
			{
				name: "wt-only",
				content: '---\nchain: "parallel(a, b)"\nworktree: true\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.ok(result.prompts.has("wt-only"));
				},
			},
			{
				name: "wt-desc",
				content: '---\nchain: "parallel(scan-fe, scan-be) -> review"\nworktree: true\ndescription: "Parallel scan"\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("wt-desc");
					assert.ok(prompt);
					const desc = buildPromptCommandDescription(prompt);
					assert.match(desc, /worktree/);
					assert.match(desc, /\[chain:.*worktree\]/);
				},
			},
		] as const;

		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", `${testCase.name}.md`), testCase.content);
			testCase.check(loadPromptsWithModel(cwd));
		}
	});
});

test("loadPromptsWithModel parses the shipped best-of-n example", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "best-of-n.md"), readFileSync(new URL("../examples/best-of-n.md", import.meta.url), "utf8"));

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("best-of-n");
		assert.ok(prompt);
		assert.equal(prompt.description, "Best-of-N code task with parallel workers using different models in separate worktrees, parallel reviewers, and a final apply step that picks or synthesizes the final patch.");
		assert.equal(prompt.worktree, true);
		assert.equal(prompt.workers?.length, 2);
		assert.deepEqual(
			prompt.workers?.map((slot) => ({ agent: slot.agent, model: slot.model, count: slot.count, taskSuffix: slot.taskSuffix })),
			[
				{ agent: "delegate", model: "openai-codex/gpt-5.3-codex-spark:low", count: 3, taskSuffix: undefined },
				{ agent: "delegate", model: "openai-codex/gpt-5.4-mini:high", count: 2, taskSuffix: undefined },
			],
		);
		assert.equal(prompt.reviewers?.length, 2);
		assert.deepEqual(
			prompt.reviewers?.map((slot) => ({ agent: slot.agent, model: slot.model, count: slot.count, taskSuffix: slot.taskSuffix })),
			[
				{ agent: "reviewer", model: "openai-codex/gpt-5.3-codex-spark:medium", count: 2, taskSuffix: undefined },
				{ agent: "reviewer", model: "openai-codex/gpt-5.4-mini:high", count: undefined, taskSuffix: "Focus extra attention on regression risk and missing edge cases." },
			],
		);
		assert.deepEqual(prompt.finalApplier, {
			agent: "delegate",
			model: "openai-codex/gpt-5.4-mini:xhigh",
			taskSuffix: "Apply the final patch directly on the current branch, run best-effort relevant verification, and report changed files plus verification run.",
		});
		assert.equal(prompt.content, "$@");
		assert.match(buildPromptCommandDescription(prompt), /workers:5/);
		assert.match(buildPromptCommandDescription(prompt), /reviewers:3/);
		assert.match(buildPromptCommandDescription(prompt), /final-applier/);
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel validates bestOfN compare lineups and cutover diagnostics", () => {
	withTempHome((root) => {
		const cases = [
			{
				name: "compare",
				content: [
					"---",
					"description: Compare",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"      taskSuffix: Save findings to notes/a.md",
					"      count: 3",
					"    - subagent: delegate",
					"  reviewers:",
					"    - taskSuffix: Prefer findings files over prose summaries.",
					"      cwd: /tmp/repo",
					"      count: 2",
					"  finalApplier:",
					"    model: openai-codex/gpt-5.4:low",
					"    taskSuffix: Prefer merge plans over narrow wins when the diffs justify it.",
					"  worktree: true",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("compare");
					assert.ok(prompt);
					assert.equal(prompt.workers?.length, 2);
					assert.equal(prompt.workers?.[0]?.agent, "delegate");
					assert.equal(prompt.workers?.[0]?.model, "openai/gpt-5.4");
					assert.equal(prompt.workers?.[0]?.taskSuffix, "Save findings to notes/a.md");
					assert.equal(prompt.workers?.[0]?.count, 3);
					assert.equal(prompt.workers?.[1]?.agent, "delegate");
					assert.equal(prompt.reviewers?.length, 1);
					assert.equal(prompt.reviewers?.[0]?.agent, "reviewer");
					assert.equal(prompt.reviewers?.[0]?.taskSuffix, "Prefer findings files over prose summaries.");
					assert.equal(prompt.reviewers?.[0]?.cwd, "/tmp/repo");
					assert.equal(prompt.reviewers?.[0]?.count, 2);
					assert.equal(prompt.finalApplier?.agent, "delegate");
					assert.equal(prompt.finalApplier?.model, "openai-codex/gpt-5.4:low");
					assert.equal(prompt.finalApplier?.taskSuffix, "Prefer merge plans over narrow wins when the diffs justify it.");
					assert.equal(prompt.worktree, true);
					assert.match(buildPromptCommandDescription(prompt), /workers:4/);
					assert.match(buildPromptCommandDescription(prompt), /reviewers:2/);
					assert.match(buildPromptCommandDescription(prompt), /final-applier/);
				},
			},
			{
				name: "legacy-workers",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"workers:",
					"  - agent: delegate",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("legacy-workers"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.workers")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('compare template authoring moved under "bestOfN:"')));
				},
			},
			{
				name: "legacy-reviewers",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"reviewers:",
					"  - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("legacy-reviewers"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.reviewers")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('compare template authoring moved under "bestOfN:"')));
				},
			},
			{
				name: "legacy-final-applier",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"finalApplier:",
					"  agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("legacy-final-applier"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.finalApplier")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('compare template authoring moved under "bestOfN:"')));
				},
			},
			{
				name: "mixed-top-level-and-bestofn",
				content: [
					"---",
					"workers:",
					"  - agent: reviewer",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("mixed-top-level-and-bestofn");
					assert.ok(prompt);
					assert.equal(prompt.workers?.length, 1);
					assert.equal(prompt.workers?.[0]?.agent, "delegate");
					assert.equal(prompt.workers?.[0]?.model, "openai/gpt-5.4");
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.workers")));
				},
			},
			{
				name: "top-level-worktree-with-bestofn",
				content: [
					"---",
					"worktree: false",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  worktree: true",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("top-level-worktree-with-bestofn");
					assert.ok(prompt);
					assert.equal(prompt.worktree, true);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.worktree")));
				},
			},
			{
				name: "bad-final-cwd",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    cwd: /tmp/other-repo",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-final-cwd");
					assert.ok(prompt);
					assert.equal(prompt.finalApplier, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("finalApplier") && d.message.includes("cwd") && d.message.includes("not supported")));
				},
			},
			{
				name: "bad-final-count",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    count: 2",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-final-count");
					assert.ok(prompt);
					assert.equal(prompt.finalApplier, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("finalApplier") && d.message.includes("count") && d.message.includes("not supported")));
				},
			},
			{
				name: "bad-bestofn-root",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"bestOfN: true",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("bad-bestofn-root"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes('"bestOfN" must be an object')));
					assert.ok(result.diagnostics.some((d) => d.message.includes('"bestOfN" did not produce a valid compare configuration')));
				},
			},
			{
				name: "compare-subagent",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"subagent: true",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    model: openai/gpt-5.4:low",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("compare-subagent"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("finalApplier") && d.message.includes("subagent")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('"bestOfN" did not produce a valid compare configuration')));
				},
			},
		] as const;

		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", `${testCase.name}.md`), testCase.content);
			testCase.check(loadPromptsWithModel(cwd));
		}
	});
});

test("reserved built-in command mirror is explicit", () => {
	assert.deepEqual([...RESERVED_COMMAND_NAMES].sort(), [
		"chain-prompts",
		"changelog",
		"compact",
		"copy",
		"export",
		"fork",
		"hotkeys",
		"login",
		"logout",
		"model",
		"name",
		"new",
		"prompt-tool",
		"quit",
		"reload",
		"resume",
		"scoped-models",
		"session",
		"settings",
		"share",
		"tree",
	].sort());
});

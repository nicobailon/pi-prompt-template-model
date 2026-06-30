import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptCommandDescription, loadPromptsWithModel } from "../prompt-loader.ts";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-deterministic-loader-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadPromptsWithModel parses deterministic shorthand and nested forms", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "push.md"), "---\nrun: git push origin HEAD:main\nhandoff: never\ntimeout: 30000\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "ship.md"), [
			"---",
			"deterministic:",
			"  script:",
			"    path: ./scripts/ship.sh",
			"    args:",
			"      - --fast",
			"  handoff: on-failure",
			"  timeout: 1500",
			"---",
			"Explain the result.",
		].join("\n"));

		const result = loadPromptsWithModel(cwd);
		const push = result.prompts.get("push");
		const ship = result.prompts.get("ship");
		assert.ok(push?.deterministic);
		assert.equal(push.deterministic?.execution.kind, "run");
		assert.equal(push.deterministic?.handoff, "never");
		assert.equal(push.deterministic?.nonInteractive, true);
		assert.equal(push.deterministic?.timeoutMs, 30000);
		assert.ok(ship?.deterministic);
		assert.equal(ship.deterministic?.execution.kind, "script");
		assert.equal(ship.deterministic?.handoff, "on-failure");
		assert.equal(ship.deterministic?.nonInteractive, true);
		assert.equal(ship.deterministic?.timeoutMs, 1500);
		assert.match(buildPromptCommandDescription(push!), /deterministic-step:never/);
	});
});

test("loadPromptsWithModel supports top-level deterministic cwd shorthand and structured run objects", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "status.md"),
			[
				"---",
				"run:",
				"  command: git",
				"  args:",
				"    - status",
				"    - --short",
				"  shell: false",
				"handoff: always",
				"cwd: ~/repo",
				"---",
				"Interpret the repo state.",
			].join("\n"),
		);

		const result = loadPromptsWithModel(cwd);
		const status = result.prompts.get("status");
		assert.ok(status?.deterministic);
		assert.equal(status.deterministic?.execution.kind, "command");
		assert.equal(status.deterministic?.execution.command, "git");
		assert.deepEqual(status.deterministic?.execution.args, ["status", "--short"]);
		assert.equal(status.deterministic?.nonInteractive, true);
		assert.equal(status.deterministic?.cwd, join(root, "repo"));
	});
});

test("loadPromptsWithModel parses deterministic env and nonInteractive overrides", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deploy.md"), [
			"---",
			"deterministic:",
			"  run: ./deploy.sh",
			"  handoff: never",
			"  nonInteractive: false",
			"  env:",
			"    FOO: bar",
			"    RETRIES: 2",
			"---",
			"ignored",
		].join("\n"));

		const result = loadPromptsWithModel(cwd);
		const deploy = result.prompts.get("deploy");
		assert.ok(deploy?.deterministic);
		assert.equal(deploy.deterministic?.nonInteractive, false);
		assert.deepEqual(deploy.deterministic?.env, { FOO: "bar", RETRIES: "2" });
	});
});

test("loadPromptsWithModel rejects invalid deterministic combinations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad.md"), "---\nrun: git push\nscript: ./push.sh\nmodel: anthropic/claude-sonnet-4-20250514\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "loop.md"), "---\nrun: git push\nloop: 2\nmodel: anthropic/claude-sonnet-4-20250514\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("bad")?.deterministic, undefined);
		assert.equal(result.prompts.get("loop")?.deterministic, undefined);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /"run" and "script" cannot be declared together/i);
		assert.match(diagnostics, /cannot be combined with "loop"/i);
	});
});

test("loadPromptsWithModel lets deterministic prompts inherit current-model execution without model frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inspect.md"), "---\nrun: printf 'ok'\nhandoff: never\n---\nignored");

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("inspect");
		assert.ok(prompt);
		assert.deepEqual(prompt.models, []);
		assert.ok(prompt.deterministic);
	});
});

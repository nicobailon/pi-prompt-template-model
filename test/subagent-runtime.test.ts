import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSubagentRuntime, resolveDelegatedAgent } from "../subagent-runtime.ts";

async function withTempDir(run: (root: string) => Promise<void> | void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-runtime-"));
	const previousHome = process.env.HOME;
	const previousRuntime = process.env.PI_SUBAGENT_RUNTIME_ROOT;
	process.env.HOME = root;
	delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
	try {
		await run(root);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousRuntime === undefined) delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		else process.env.PI_SUBAGENT_RUNTIME_ROOT = previousRuntime;
		rmSync(root, { recursive: true, force: true });
	}
}

function writeRuntime(root: string) {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "agents.js"),
		"export function discoverAgents(){ return { agents: [{ name: 'delegate' }, { name: 'reviewer' }] }; }",
	);
}

test("ensureSubagentRuntime loads discoverAgents from configured runtime root", async () => {
	await withTempDir(async (root) => {
		const runtimeRoot = join(root, "custom-runtime");
		writeRuntime(runtimeRoot);
		process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;

		const runtime = await ensureSubagentRuntime(root);
		assert.equal(resolveDelegatedAgent(runtime, root, "delegate"), "delegate");
	});
});

test("ensureSubagentRuntime fails when configured runtime root is missing", async () => {
	await withTempDir(async (root) => {
		process.env.PI_SUBAGENT_RUNTIME_ROOT = join(root, "missing-runtime");

		await assert.rejects(
			() => ensureSubagentRuntime(root),
			/pi-subagents.*PI_SUBAGENT_RUNTIME_ROOT/i,
		);
	});
});

test("ensureSubagentRuntime discovers project-local pi-subagents npm installs", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		const runtimeRoot = join(project, ".pi", "npm", "node_modules", "pi-subagents");
		writeRuntime(runtimeRoot);

		const runtime = await ensureSubagentRuntime(project);
		assert.equal(runtime.root, runtimeRoot);
		assert.equal(resolveDelegatedAgent(runtime, project, "reviewer"), "reviewer");
	});
});

test("ensureSubagentRuntime does not discover legacy subagent extension paths", async () => {
	await withTempDir(async (root) => {
		const project = join(root, "project");
		writeRuntime(join(project, ".pi", "agent", "extensions", "subagent"));
		writeRuntime(join(root, ".pi", "agent", "extensions", "subagent"));

		await assert.rejects(
			() => ensureSubagentRuntime(project),
			/pi-subagents.*PI_SUBAGENT_RUNTIME_ROOT/i,
		);
	});
});

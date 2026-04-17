import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSubagentRuntime, findSubagentRoot, resolveDelegatedAgent, runtimeCandidatesFor } from "../subagent-runtime.js";

async function withTempDir(run: (root: string) => Promise<void> | void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-runtime-"));
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("ensureSubagentRuntime loads discoverAgents from configured runtime root", async () => {
	await withTempDir(async (root) => {
		const runtimeRoot = join(root, "subagent");
		mkdirSync(runtimeRoot, { recursive: true });
		writeFileSync(
			join(runtimeRoot, "agents.js"),
			"export function discoverAgents(){ return { agents: [{ name: 'delegate' }, { name: 'reviewer' }] }; }",
		);

		const prev = process.env.PI_SUBAGENT_RUNTIME_ROOT;
		process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;
		try {
			const runtime = await ensureSubagentRuntime(root);
			assert.equal(resolveDelegatedAgent(runtime, root, "delegate"), "delegate");
		} finally {
			if (prev === undefined) delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
			else process.env.PI_SUBAGENT_RUNTIME_ROOT = prev;
		}
	});
});

test("ensureSubagentRuntime fails when configured runtime root is missing", async () => {
	await withTempDir(async (root) => {
		const prev = process.env.PI_SUBAGENT_RUNTIME_ROOT;
		process.env.PI_SUBAGENT_RUNTIME_ROOT = join(root, "missing-runtime");
		try {
			await assert.rejects(() => ensureSubagentRuntime(root), /requires the subagent extension runtime/i);
		} finally {
			if (prev !== undefined) process.env.PI_SUBAGENT_RUNTIME_ROOT = prev;
			else delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		}
	});
});

test("runtimeCandidatesFor includes sibling pi-subagents package for npm-style installs", () => {
	const cwd = "/repo";
	const moduleDir = "/opt/pi/node_modules/pi-prompt-template-model";
	const candidates = runtimeCandidatesFor(cwd, moduleDir);
	assert.ok(candidates.includes("/opt/pi/node_modules/pi-subagents"));
});

test("findSubagentRoot discovers pi-subagents under another owner in pi-managed git installs", async () => {
	await withTempDir(async (root) => {
		const cwd = join(root, "workspace");
		const moduleDir = join(root, "git", "github.com", "lbowenwest", "pi-prompt-template-model");
		const runtimeRoot = join(root, "git", "github.com", "nicobailon", "pi-subagents");
		mkdirSync(moduleDir, { recursive: true });
		mkdirSync(runtimeRoot, { recursive: true });
		writeFileSync(
			join(runtimeRoot, "agents.js"),
			"export function discoverAgents(){ return { agents: [{ name: 'delegate' }] }; }",
		);
		assert.equal(findSubagentRoot(cwd, moduleDir), runtimeRoot);
	});
});

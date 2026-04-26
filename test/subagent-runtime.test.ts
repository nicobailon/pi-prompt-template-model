import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSubagentRuntime, resolveDelegatedAgent } from "../subagent-runtime.js";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function withTempDir(run: (root: string) => Promise<void> | void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-runtime-"));
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeRuntimeModule(root: string, agentNames: string[]): void {
	mkdirSync(root, { recursive: true });
	const agents = agentNames.map((name) => `{ name: '${name}' }`).join(", ");
	writeFileSync(join(root, "agents.js"), `export function discoverAgents(){ return { agents: [${agents}] }; }`);
}

test("ensureSubagentRuntime loads discoverAgents from configured runtime root", async () => {
	await withTempDir(async (root) => {
		const runtimeRoot = join(root, "subagent");
		writeRuntimeModule(runtimeRoot, ["delegate", "reviewer"]);

		const previousRuntimeRoot = process.env.PI_SUBAGENT_RUNTIME_ROOT;
		process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;
		try {
			const runtime = await ensureSubagentRuntime(root);
			assert.equal(resolveDelegatedAgent(runtime, root, "delegate"), "delegate");
		} finally {
			restoreEnv("PI_SUBAGENT_RUNTIME_ROOT", previousRuntimeRoot);
		}
	});
});

test("ensureSubagentRuntime fails when configured runtime root is missing", async () => {
	await withTempDir(async (root) => {
		const previousRuntimeRoot = process.env.PI_SUBAGENT_RUNTIME_ROOT;
		process.env.PI_SUBAGENT_RUNTIME_ROOT = join(root, "missing-runtime");
		try {
			await assert.rejects(() => ensureSubagentRuntime(root), /requires the pi-subagents runtime/i);
		} finally {
			restoreEnv("PI_SUBAGENT_RUNTIME_ROOT", previousRuntimeRoot);
		}
	});
});

test("ensureSubagentRuntime discovers project-local .pi/extensions layout", async () => {
	await withTempDir(async (root) => {
		const previousRuntimeRoot = process.env.PI_SUBAGENT_RUNTIME_ROOT;
		const previousHome = process.env.HOME;
		delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		process.env.HOME = join(root, "fake-home");
		const runtimeRoot = join(root, ".pi", "extensions", "subagent");
		writeRuntimeModule(runtimeRoot, ["delegate", "local-ext"]);

		try {
			const runtime = await ensureSubagentRuntime(root);
			assert.equal(runtime.root, runtimeRoot);
			assert.equal(resolveDelegatedAgent(runtime, root, "local-ext"), "local-ext");
		} finally {
			restoreEnv("PI_SUBAGENT_RUNTIME_ROOT", previousRuntimeRoot);
			restoreEnv("HOME", previousHome);
		}
	});
});

test("ensureSubagentRuntime discovers project-local .pi/git layout for pi packages", async () => {
	await withTempDir(async (root) => {
		const previousRuntimeRoot = process.env.PI_SUBAGENT_RUNTIME_ROOT;
		const previousHome = process.env.HOME;
		delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		process.env.HOME = join(root, "fake-home");
		const runtimeRoot = join(root, ".pi", "git", "github.com", "badlogic", "pi-subagents");
		writeRuntimeModule(runtimeRoot, ["delegate", "git-local"]);
		writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "pi-subagents" }));

		try {
			const runtime = await ensureSubagentRuntime(root);
			assert.equal(runtime.root, runtimeRoot);
			assert.equal(resolveDelegatedAgent(runtime, root, "git-local"), "git-local");
		} finally {
			restoreEnv("PI_SUBAGENT_RUNTIME_ROOT", previousRuntimeRoot);
			restoreEnv("HOME", previousHome);
		}
	});
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolManager } from "../tool-manager.js";

class FakePi {
	commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	tools = new Map<string, { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }>();

	registerCommand(name: string, command: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
		this.commands.set(name, command);
	}

	registerTool(tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }) {
		this.tools.set(tool.name, tool);
	}
}

async function withTempHome(run: () => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-queue-state-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run();
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("tool manager exposes whether a prompt command is queued", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => ({} as never),
			setStoredCtx: () => {},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", { hasUI: false, ui: { notify() {} } });

		assert.equal(manager.hasQueuedCommand(), false);
		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await tool.execute("tool-call", { command: "example" });
		assert.equal(manager.hasQueuedCommand(), true);

		await manager.processQueue({ hasUI: false, ui: { notify() {} } } as never, async () => {});
		assert.equal(manager.hasQueuedCommand(), false);
	});
});

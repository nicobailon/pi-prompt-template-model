import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolManager } from "../tool-manager.ts";

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface FakeTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<any>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, FakeTool>();

	registerCommand(name: string, command: FakeCommand) {
		this.commands.set(name, command);
	}

	registerTool(tool: FakeTool) {
		this.tools.set(tool.name, tool);
	}
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-tool-manager-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createNotifyCtx(notifications: string[]) {
	return {
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	};
}

test("config load/save persists toolEnabled and is loaded by new manager", async () => {
	await withTempHome(async (root) => {
		const pi = new FakePi();
		let storedCtx: any = null;
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));
		assert.equal(manager.isEnabled(), true);

		const configPath = join(root, ".pi", "agent", "prompt-template-model.json");
		assert.equal(existsSync(configPath), true);
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		assert.equal(raw.toolEnabled, true);

		const piReload = new FakePi();
		const reloaded = createToolManager(piReload as never, {
			isActive: () => false,
			getStoredCtx: () => null,
			setStoredCtx: () => {},
			executeCommand: async () => {},
		});

		assert.equal(reloaded.isEnabled(), true);
	});
});

test("config missing file defaults to disabled with no guidance", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => null,
			setStoredCtx: () => {},
			executeCommand: async () => {},
		});

		assert.equal(manager.isEnabled(), false);
		assert.equal(manager.getGuidance(), null);
	});
});

test("registerCommand on/off toggles enabled state", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = null;
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);

		await command.handler("on", createNotifyCtx([]));
		assert.equal(manager.isEnabled(), true);

		await command.handler("off", createNotifyCtx([]));
		assert.equal(manager.isEnabled(), false);
	});
});

test("guidance set and clear through prompt-tool command", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = null;
		const notifications: string[] = [];
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);

		await command.handler("on some guidance", createNotifyCtx(notifications));
		assert.equal(manager.getGuidance(), "some guidance");
		await command.handler("guidance show", createNotifyCtx(notifications));
		assert.match(notifications.join("\n"), /Current guidance: "some guidance"/);

		await command.handler("guidance clear", createNotifyCtx([]));
		assert.equal(manager.getGuidance(), null);
	});
});

test("run-prompt rejects queueing while command execution is active", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let active = false;
		let storedCtx: any = {};
		const manager = createToolManager(pi as never, {
			isActive: () => active,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));
		active = true;

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		const result = await tool.execute("tool-call", { command: "example" });

		assert.equal(result.content[0].text, "A prompt command is already running. Wait for it to complete.");
	});
});

test("run-prompt rejects queueing when stored command context is missing", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => null,
			setStoredCtx: () => {},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await assert.rejects(
			() => tool.execute("tool-call", { command: "example" }),
			/No command context\. Run any prompt command first to initialize\./,
		);
	});
});

test("run-prompt treats non-string command payloads as typed input errors", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = {};
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await assert.rejects(
			() => tool.execute("tool-call", { command: 123 as never }),
			/No command specified\./,
		);
	});
});

test("manager reports whether a prompt command is queued", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = {};
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));
		assert.equal(manager.hasQueuedCommand(), false);

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await tool.execute("tool-call", { command: "example" });
		assert.equal(manager.hasQueuedCommand(), true);

		await manager.processQueue(createNotifyCtx([]) as never, async () => {});
		assert.equal(manager.hasQueuedCommand(), false);
	});
});

test("clearQueue removes queued command before processQueue", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = {};
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await tool.execute("tool-call", { command: "example" });
		manager.clearQueue();

		let restoreCalled = false;
		const processed = await manager.processQueue(createNotifyCtx([]) as never, async () => {
			restoreCalled = true;
		});

		assert.equal(processed, false);
		assert.equal(restoreCalled, false);
	});
});

test("processQueue returns false when queue is empty", async () => {
	await withTempHome(async () => {
		const manager = createToolManager(new FakePi() as never, {
			isActive: () => false,
			getStoredCtx: () => ({} as never),
			setStoredCtx: () => {},
			executeCommand: async () => {},
		});

		let restoreCalled = false;
		const processed = await manager.processQueue(createNotifyCtx([]) as never, async () => {
			restoreCalled = true;
		});

		assert.equal(processed, false);
		assert.equal(restoreCalled, false);
	});
});

test("processQueue executes restore before executeCommand", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = {};
		const order: string[] = [];
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {
				order.push("execute");
			},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await tool.execute("tool-call", { command: "example" });

		const processed = await manager.processQueue(createNotifyCtx([]) as never, async () => {
			order.push("restore");
		});

		assert.equal(processed, true);
		assert.deepEqual(order, ["restore", "execute"]);
	});
});

test("processQueue catches executeCommand errors and returns true", async () => {
	await withTempHome(async () => {
		const pi = new FakePi();
		let storedCtx: any = {};
		const notifications: string[] = [];
		const manager = createToolManager(pi as never, {
			isActive: () => false,
			getStoredCtx: () => storedCtx,
			setStoredCtx: (ctx) => {
				storedCtx = ctx;
			},
			executeCommand: async () => {
				throw new Error("boom");
			},
		});
		manager.registerCommand();

		const command = pi.commands.get("prompt-tool");
		assert.ok(command);
		await command.handler("on", createNotifyCtx([]));

		const tool = pi.tools.get("run-prompt");
		assert.ok(tool);
		await tool.execute("tool-call", { command: "example" });

		const processed = await manager.processQueue(createNotifyCtx(notifications) as never, async () => {});

		assert.equal(processed, true);
		assert.match(notifications.join("\n"), /Failed to execute queued prompt command "example": boom/);
	});
});

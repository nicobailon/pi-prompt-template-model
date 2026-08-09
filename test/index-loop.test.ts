import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.ts";
import {
	PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT,
	PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT,
	PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
	PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT,
	PROMPT_TEMPLATE_PROMPT_STARTED_EVENT,
	PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
} from "../subagent-runtime.ts";

const MODEL_ID = "claude-sonnet-4-20250514";
const ACTIVE_MODEL = { provider: "anthropic", id: MODEL_ID };

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
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	bus = new Map<string, Array<(data: unknown) => void>>();
	events = {
		emit: (channel: string, data: unknown) => {
			for (const handler of this.bus.get(channel) ?? []) {
				handler(data);
			}
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? [];
			handlers.push(handler);
			this.bus.set(channel, handlers);
			return () => {
				const current = this.bus.get(channel) ?? [];
				this.bus.set(channel, current.filter((candidate) => candidate !== handler));
			};
		},
	};
	skillCommands: Array<{ name: string; source: "skill"; sourceInfo: { path: string } }> = [];
	userMessages: string[] = [];
	setModelCalls: string[] = [];
	thinkingCalls: string[] = [];
	currentModel = ACTIVE_MODEL;
	private thinking = "medium";

	registerMessageRenderer() {}

	registerCommand(name: string, command: FakeCommand) {
		this.commands.set(name, command);
	}

	registerTool(tool: FakeTool) {
		this.tools.set(tool.name, tool);
	}

	getCommands() {
		return this.skillCommands;
	}

	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}

	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	async emitWithResult(event: string, payload: any, ctx: any) {
		let combined: Record<string, unknown> | undefined;
		for (const handler of this.hooks.get(event) ?? []) {
			const result = await handler(payload, ctx);
			if (!result || typeof result !== "object") continue;
			combined = { ...(combined ?? {}), ...(result as Record<string, unknown>) };
		}
		return combined;
	}

	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}

	getThinkingLevel() {
		return this.thinking;
	}

	setThinkingLevel(level: string) {
		this.thinking = level;
		this.thinkingCalls.push(level);
	}

	sendUserMessage(content: string) {
		this.userMessages.push(content);
	}

	sendMessage(_message?: any) {}
}

function stripLoopPrefix(msg: string): string {
	return msg.replace(/^\[.*?\]\n\n/, "");
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(
	cwd: string,
	pi: FakePi,
	models: Array<{ provider: string; id: string }> = [ACTIVE_MODEL],
	options?: { branchEntries?: () => any[]; waitForIdle?: () => Promise<void>; isIdle?: () => boolean },
) {
	let navigateCount = 0;
	const notifications: string[] = [];
	const modelRegistry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "token" };
			},
		isUsingOAuth() {
			return false;
		},
	};

	const ctx = {
		cwd,
		mode: "tui",
		scopedModels: [],
		isProjectTrusted() { return true; },
		get model() {
			return pi.currentModel;
		},
		modelRegistry,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: {
				fg(_token: string, text: string) {
					return text;
				},
			},
		},
		isIdle() {
			return options?.isIdle ? options.isIdle() : false;
		},
		async waitForIdle() {
			if (options?.waitForIdle) {
				await options.waitForIdle();
			}
		},
		sessionManager: {
			getLeafId() {
				return "root";
			},
			getBranch() {
				return options?.branchEntries ? options.branchEntries() : [];
			},
		},
		async navigateTree() {
			navigateCount++;
			return { cancelled: false };
		},
	};

	return {
		ctx,
		getNavigateCount: () => navigateCount,
		getNotifications: () => notifications,
	};
}

test("direct prompt command waits for tracked compaction before sending user message", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\ndeslop task`);

		let idle = true;
		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL], { isIdle: () => idle });
		pi.sendUserMessage = (content: string) => {
			idle = false;
			pi.userMessages.push(content);
		};
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		await pi.emit("session_before_compact", { signal: new AbortController().signal }, ctx);

		const commandRun = pi.commands.get("deslop")!.handler("", ctx);
		await Promise.resolve();
		assert.equal(pi.userMessages.length, 0);

		await pi.emit("session_compact", {}, ctx);
		await commandRun;

		assert.equal(pi.userMessages.length, 1);
		assert.equal(pi.userMessages[0], "deslop task");
	});
});

test("emits one defensive lifecycle pair for an inline prompt run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inline.md"), `---\nmodel: ${MODEL_ID}\n---\ninline task`);

		const pi = new FakePi();
		const lifecycle: Array<{ channel: string; data: any }> = [];
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (data) => lifecycle.push({ channel: PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, data }));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (data) => lifecycle.push({ channel: PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, data }));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, () => { throw new Error("observer failure"); });
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("inline")!.handler("", ctx);

		assert.equal(lifecycle.length, 2);
		assert.equal(lifecycle[0]!.channel, PROMPT_TEMPLATE_PROMPT_STARTED_EVENT);
		assert.equal(lifecycle[1]!.channel, PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT);
		assert.equal(lifecycle[0]!.data.protocolVersion, PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION);
		assert.equal(lifecycle[1]!.data.protocolVersion, PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION);
		assert.equal(lifecycle[0]!.data.name, "inline");
		assert.equal(lifecycle[1]!.data.name, "inline");
		assert.equal(lifecycle[0]!.data.runId, lifecycle[1]!.data.runId);
		assert.equal(lifecycle[1]!.data.status, "completed");
		assert.equal(lifecycle[1]!.data.changed, false);
		assert.deepEqual(getNotifications(), ["Prompt lifecycle observer failed: observer failure"]);
	});
});

test("accepts invocation requests through the command path and correlates lifecycle events", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invoke.md"), `---\nmodel: ${MODEL_ID}\n---\ninvoked $@`);

		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const lifecycle: any[] = [];
		let resolveFinished!: (payload: any) => void;
		const finished = new Promise<any>((resolve) => { resolveFinished = resolve; });
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload: any) => {
			if (payload.accepted) writeFileSync(join(cwd, ".pi", "prompts", "invoke.md"), "---\nchain: first\n---\nrewritten");
		});
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, () => { throw new Error("ack observer failure"); });
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (payload) => lifecycle.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => {
			lifecycle.push(payload);
			resolveFinished(payload);
		});
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		delete (ctx as any).waitForIdle;
		delete (ctx as any).navigateTree;
		let idle = true;
		ctx.isIdle = () => idle;
		const sendUserMessage = pi.sendUserMessage.bind(pi);
		pi.sendUserMessage = (content: string) => {
			sendUserMessage(content);
			idle = false;
			setTimeout(() => { idle = true; }, 0);
		};
		await pi.emit("session_start", {}, ctx);

		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-1",
			name: "invoke",
			args: "hello world",
		});

		const finishedPayload = await finished;
		assert.deepEqual(acknowledgements, [{
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-1",
			name: "invoke",
			accepted: true,
			runId: acknowledgements[0].runId,
		}]);
		assert.equal(acknowledgements[0].runId, lifecycle[0].runId);
		assert.equal(finishedPayload.runId, acknowledgements[0].runId);
		assert.equal(lifecycle.length, 2);
		assert.equal(finishedPayload.name, "invoke");
		assert.equal(finishedPayload.status, "completed");
		assert.equal(pi.userMessages.at(-1), "invoked hello world");
		assert.deepEqual(getNotifications(), ["Prompt invocation observer failed: ack observer failure"]);
	});
});

test("refuses invocation requests while the Pi session is non-idle", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invoke.md"), `---\nmodel: ${MODEL_ID}\n---\ninvoked`);

		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const lifecycle: any[] = [];
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (payload) => lifecycle.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => lifecycle.push(payload));
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-session-busy",
			name: "invoke",
		});

		assert.deepEqual(acknowledgements, [{
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-session-busy",
			name: "invoke",
			accepted: false,
			reason: "busy",
		}]);
		assert.deepEqual(lifecycle, []);
	});
});

test("refuses unknown invocation requests without starting a run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const lifecycle: any[] = [];
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (payload) => lifecycle.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => lifecycle.push(payload));
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		ctx.isIdle = () => true;
		await pi.emit("session_start", {}, ctx);

		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-missing",
			name: "missing",
		});

		assert.deepEqual(acknowledgements, [{
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-missing",
			name: "missing",
			accepted: false,
			reason: "unknown-template",
		}]);
		assert.deepEqual(lifecycle, []);
	});
});

test("refuses invocation requests while a prompt run is active", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invoke.md"), `---\nmodel: ${MODEL_ID}\n---\ninvoked`);

		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const lifecycle: any[] = [];
		let resolveFinished!: (payload: any) => void;
		const finished = new Promise<any>((resolve) => { resolveFinished = resolve; });
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, () => { throw new Error("ack observer failure"); });
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (payload) => {
			lifecycle.push(payload);
			pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId: "graph-busy",
				name: "invoke",
			});
		});
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => {
			lifecycle.push(payload);
			resolveFinished(payload);
		});
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		let idle = true;
		ctx.isIdle = () => idle;
		const sendUserMessage = pi.sendUserMessage.bind(pi);
		pi.sendUserMessage = (content: string) => {
			sendUserMessage(content);
			idle = false;
		};
		await pi.emit("session_start", {}, ctx);

		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-first",
			name: "invoke",
		});
		await finished;

		assert.equal(acknowledgements.length, 2);
		assert.equal(acknowledgements[0].accepted, true);
		assert.equal(acknowledgements[1].requestId, "graph-busy");
		assert.equal(acknowledgements[1].accepted, false);
		assert.equal(acknowledgements[1].reason, "busy");
		assert.equal(lifecycle.length, 2);
		assert.equal(lifecycle[0].runId, lifecycle[1].runId);
	});
});

test("refuses chain-template invocation requests without starting a run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain.md"), "---\nchain: first\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nfirst`);

		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const lifecycle: any[] = [];
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (payload) => lifecycle.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => lifecycle.push(payload));
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		ctx.isIdle = () => true;
		await pi.emit("session_start", {}, ctx);

		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-chain",
			name: "chain",
		});

		assert.equal(acknowledgements[0].accepted, false);
		assert.equal(acknowledgements[0].reason, "chain-template");
		assert.deepEqual(lifecycle, []);
	});
});

test("chain template validation failure emits failed lifecycle status", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: missing\n---\nignored");

		const pi = new FakePi();
		const lifecycle: Array<{ channel: string; data: any }> = [];
		pi.events.on(PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, (data) => lifecycle.push({ channel: PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, data }));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (data) => lifecycle.push({ channel: PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, data }));
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("pipeline")!.handler("", ctx);

		assert.match(getNotifications().join("\n"), /Templates not found: missing/);
		assert.equal(lifecycle.length, 2);
		assert.equal(lifecycle[0]!.channel, PROMPT_TEMPLATE_PROMPT_STARTED_EVENT);
		assert.equal(lifecycle[1]!.channel, PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT);
		assert.equal(lifecycle[0]!.data.runId, lifecycle[1]!.data.runId);
		assert.equal(lifecycle[1]!.data.name, "pipeline");
		assert.equal(lifecycle[1]!.data.status, "failed");
	});
});

test("refuses invocation while a direct chain command is finishing", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nworker`);
		writeFileSync(join(cwd, ".pi", "prompts", "invoke.md"), `---\nmodel: ${MODEL_ID}\n---\ninvoke`);

		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const { ctx } = createBranchingContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "worker done" }] }],
				isError: false,
			});
		});

		let injected = false;
		const waitForIdle = ctx.waitForIdle.bind(ctx);
		ctx.waitForIdle = async () => {
			if (!injected) {
				injected = true;
				pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
					protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
					requestId: "graph-direct-chain",
					name: "invoke",
				});
			}
			await waitForIdle();
		};

		await pi.commands.get("chain-prompts")!.handler("worker", ctx);
		assert.deepEqual(acknowledgements, [{
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "graph-direct-chain",
			name: "invoke",
			accepted: false,
			reason: "busy",
		}]);
	});
});

test("initializes prompt commands from session cwd, not process cwd", async () => {
	await withTempHome(async (root) => {
		const processCwd = join(root, "process-cwd");
		const sessionCwd = join(root, "session-cwd");
		mkdirSync(join(processCwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(sessionCwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(processCwd, ".pi", "prompts", "process-only.md"), `---\nmodel: ${MODEL_ID}\n---\nprocess`);
		writeFileSync(join(sessionCwd, ".pi", "prompts", "session-only.md"), `---\nmodel: ${MODEL_ID}\n---\nsession`);

		const previousCwd = process.cwd();
		try {
			process.chdir(processCwd);
			const pi = new FakePi();
			promptModelExtension(pi as never);

			assert.equal(pi.commands.has("process-only"), false);

			const { ctx } = createContext(sessionCwd, pi);
			await pi.emit("session_start", { reason: "startup" }, ctx);

			assert.equal(pi.commands.has("session-only"), true);
			assert.equal(pi.commands.has("process-only"), false);
		} finally {
			process.chdir(previousCwd);
		}
	});
});

function createBranchingContext(
	cwd: string,
	pi: FakePi,
	models: Array<{ provider: string; id: string }> = [ACTIVE_MODEL],
	initialEntries: any[] = [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }],
) {
	const branch = [...initialEntries];
	const notifications: string[] = [];
	let navigateCount = 0;
	let entryCounter = 0;
	const queuedAssistantEntries: Array<Array<{ type: string; [key: string]: unknown }>> = [];
	const nextId = (prefix: string) => `${prefix}-${++entryCounter}`;

	const modelRegistry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "token" };
			},
		isUsingOAuth() {
			return false;
		},
	};

	pi.sendUserMessage = (content: string) => {
		pi.userMessages.push(content);
		branch.push({
			id: nextId("user"),
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: content }],
			},
		});
	};

	pi.sendMessage = (message: any) => {
		branch.push({
			id: nextId("custom"),
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	};

	const ctx = {
		cwd,
		mode: "print",
		scopedModels: [],
		isProjectTrusted() { return true; },
		get model() {
			return pi.currentModel;
		},
		modelRegistry,
		hasUI: false,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: {
				fg(_token: string, text: string) {
					return text;
				},
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {
			const nextAssistant = queuedAssistantEntries.shift();
			if (!nextAssistant) return;
			branch.push({
				id: nextId("assistant"),
				type: "message",
				message: {
					role: "assistant",
					content: nextAssistant,
				},
			});
		},
		sessionManager: {
			getLeafId() {
				return branch[branch.length - 1]?.id ?? null;
			},
			getBranch() {
				return branch;
			},
		},
		async navigateTree() {
			navigateCount++;
			return { cancelled: false };
		},
	};

	return {
		ctx,
		branch,
		queueAssistantText(text: string) {
			queuedAssistantEntries.push([{ type: "text", text }]);
		},
		queueAssistantContent(content: Array<{ type: string; [key: string]: unknown }>) {
			queuedAssistantEntries.push(content);
		},
		getNavigateCount: () => navigateCount,
		getNotifications: () => notifications,
	};
}

async function withSubagentBridge(_root: string, run: () => Promise<void>) {
	await run();
}

test("bare --loop with --no-converge respects no-converge and converges only on default", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		// bare --loop without --no-converge: converges on first no-change iteration
		await deslop.handler("task --loop", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("bounded --loop N runs requested iterations when no-converge is set", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 3 --no-converge", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.ok(pi.userMessages[0].startsWith("[Loop 1/3]"));
		assert.ok(pi.userMessages[1].startsWith("[Loop 2/3]"));
		assert.ok(pi.userMessages[2].startsWith("[Loop 3/3]"));
		assert.match(getNotifications().join("\n"), /Loop finished: 3\/3 iterations/);
	});
});

test("loop rotation cycles models across iterations", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-models.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two, anthropic/rotate-three\nloop: 6\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const rotateThree = { provider: "anthropic", id: "rotate-three" };
		const models = [baseModel, rotateOne, rotateTwo, rotateThree];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateModels = pi.commands.get("rotate-models");
		assert.ok(rotateModels);
		await rotateModels.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, [
			"anthropic/rotate-one",
			"anthropic/rotate-two",
			"anthropic/rotate-three",
			"anthropic/rotate-one",
			"anthropic/rotate-two",
			"anthropic/rotate-three",
		]);
	});
});

test("loop rotation cycles comma-separated thinking levels across iterations", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two, anthropic/rotate-three\nthinking: high, xhigh, off\nloop: 6\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const rotateThree = { provider: "anthropic", id: "rotate-three" };
		const models = [baseModel, rotateOne, rotateTwo, rotateThree];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateThinking = pi.commands.get("rotate-thinking");
		assert.ok(rotateThinking);
		await rotateThinking.handler("", ctx);

		assert.deepEqual(pi.thinkingCalls, ["high", "xhigh", "off", "high", "xhigh", "off"]);
	});
});

test("loop rotation still converges early when an iteration makes no changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-converge.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two, anthropic/rotate-three\nloop: 6\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const rotateThree = { provider: "anthropic", id: "rotate-three" };
		const models = [baseModel, rotateOne, rotateTwo, rotateThree];
		const changedBranchEntries = () =>
			pi.userMessages.length <= 1
				? [
					{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
					{
						id: "write-1",
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
						},
					},
				]
				: [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, models, { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const rotateConverge = pi.commands.get("rotate-converge");
		assert.ok(rotateConverge);
		await rotateConverge.handler("", ctx);

		assert.equal(pi.userMessages.length, 2);
		assert.match(getNotifications().join("\n"), /Loop converged at 2\/6 \(no changes\)/);
	});
});

test("loop rotation is a no-op for single-model prompts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-single.md"),
			"---\nmodel: anthropic/rotate-one\nloop: 3\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const models = [baseModel, rotateOne];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateSingle = pi.commands.get("rotate-single");
		assert.ok(rotateSingle);
		await rotateSingle.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/rotate-one"]);
		assert.equal(pi.userMessages.length, 3);
	});
});

test("loop notifications include the rotation label", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-notify.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two\nthinking: high, xhigh\nloop: 2\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const models = [baseModel, rotateOne, rotateTwo];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateNotify = pi.commands.get("rotate-notify");
		assert.ok(rotateNotify);
		await rotateNotify.handler("", ctx);

		const notifications = getNotifications().join("\n");
		assert.match(notifications, /Loop 1\/2: rotate-notify \[rotate-one high\]/);
		assert.match(notifications, /Loop 2\/2: rotate-notify \[rotate-two xhigh\]/);
	});
});

test("loop prompts without rotation keep fallback model semantics", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "fallback-loop.md"),
			"---\nmodel: anthropic/fallback-one, anthropic/fallback-two\nloop: 2\nconverge: false\nrestore: false\n---\nFALLBACK",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const fallbackOne = { provider: "anthropic", id: "fallback-one" };
		const fallbackTwo = { provider: "anthropic", id: "fallback-two" };
		const models = [baseModel, fallbackOne, fallbackTwo];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const fallbackLoop = pi.commands.get("fallback-loop");
		assert.ok(fallbackLoop);
		await fallbackLoop.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/fallback-one"]);
	});
});

test("bare --loop stops at unlimited cap when each iteration makes changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const changedBranchEntries = () => [
			{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
			{
				id: "write-1",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
				},
			},
		];

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop", ctx);

		assert.equal(pi.userMessages.length, 999);
		assert.match(getNotifications().join("\n"), /Loop finished: 999 iterations \(cap reached\)/);
	});
});

test("frontmatter loop executes without --loop and strips loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 3\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("frontmatter loop: unlimited runs until convergence by default", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: unlimited\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("frontmatter loop: true is equivalent to loop: unlimited", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: true\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("frontmatter loop: unlimited with converge: false runs to cap", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: unlimited\nconverge: false\n---\nARGS:$@`);

		const changedBranchEntries = () => [
			{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
			{
				id: "write-1",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
				},
			},
		];

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		assert.equal(pi.userMessages.length, 999);
		assert.match(getNotifications().join("\n"), /Loop finished: 999 iterations \(cap reached\)/);
	});
});

test("frontmatter loop: unlimited shows iteration count without total in status", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: unlimited\nconverge: false\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		const notifications = getNotifications().join("\n");
		assert.match(notifications, /Loop 1: deslop/);
		assert.doesNotMatch(notifications, /Loop 1\/\d+/);
	});
});

test("chain templates support bare --loop as unlimited with convergence", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task --loop", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("CLI --loop overrides frontmatter loop and strips repeated loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 5\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 2 --fresh --fresh --no-converge --no-converge", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 1);
	});
});

test("queued run-prompt applies bare --loop semantics", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-loop", { command: "deslop task --loop" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("chain templates route before non-chain loop extraction and run with CLI --loop", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task --loop 2 --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task", "WORK:task"]);
	});
});

test("chain templates apply frontmatter loop/fresh/converge defaults", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 3\nfresh: true\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task", "WORK:task", "WORK:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("chain templates without loop frontmatter preserve --fresh and --no-converge args", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("--fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:--fresh --no-converge"]);
	});
});

test("chain templates honor per-step --loop counts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first --loop 2 -> second --loop 3\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nfirst`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nsecond`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["first", "first", "second", "second", "second"]);
	});
});

test("parallel chain steps reject per-task --loop values", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe --loop 2)"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nscan`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /does not support per-task --loop/i);
	});
});

test("chain templates treat quoted --loop step args as literals", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: worker "--loop" "2"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker:$1:$2`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["worker:--loop:2"]);
	});
});

test("per-step convergence stops on first no-change iteration when step converge is enabled", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker --loop 3\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["worker"]);
	});
});

test("chain template execution rejects chain nesting when a step is a chain template", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "outer.md"), "---\nchain: inner\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), `---\nmodel: ${MODEL_ID}\n---\nleaf`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const outer = pi.commands.get("outer");
		assert.ok(outer);
		await outer.handler("", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /chain nesting is not supported/i);
	});
});

test("chain nesting is rejected when a step references a chain template", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), `---\nmodel: ${MODEL_ID}\n---\nleaf`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("inner", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /chain nesting is not supported/i);
	});
});

test("chain steps without model inherit the chain-start model deterministically", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/target-model\n---\nFIRST");
		writeFileSync(
			join(cwd, ".pi", "prompts", "second.md"),
			'---\ndescription: "inherits"\n---\nSECOND:<if-model is="anthropic/base-model">BASE<else>OTHER</if-model>',
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("first -> second", ctx);

		assert.deepEqual(pi.userMessages, ["FIRST", "SECOND:BASE"]);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
	});
});

test("chain-prompts rejects empty step segments", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nfirst`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\n---\nsecond`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("first -> -> second", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /invalid chain step/i);
	});
});

test("chain-prompts resolves plain non-extension prompts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "plain"\n---\nDOUBLE:$@');
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), '---\ndescription: "plain"\n---\nDESLOP:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("double-check -> deslop -- file.ts", ctx);

		assert.deepEqual(pi.userMessages, ["DOUBLE:file.ts", "DESLOP:file.ts"]);
	});
});

test("chain templates use step args first and fall back to shared CLI args", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first explicit -> second\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nFIRST:$1`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\n---\nSECOND:$1`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("shared", ctx);

		assert.deepEqual(pi.userMessages, ["FIRST:explicit", "SECOND:shared"]);
	});
});

test("chain template restore false leaves final model active", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first -> second\nrestore: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/first-model\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: anthropic/second-model\n---\nsecond");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const firstModel = { provider: "anthropic", id: "first-model" };
		const secondModel = { provider: "anthropic", id: "second-model" };
		const models = [baseModel, firstModel, secondModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/first-model", "anthropic/second-model"]);
		assert.deepEqual(pi.currentModel, secondModel);
	});
});

test("queued run-prompt executes chain templates through runPromptCommand routing", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-chain", { command: "pipeline task --loop 2 --no-converge" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.userMessages, ["worker:task", "worker:task"]);
	});
});

test("queued run-prompt restores pending session state before executing queued command", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/loop-first\nrestore: true\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: anthropic/loop-second\nrestore: true\n---\nsecond");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const firstModel = { provider: "anthropic", id: "loop-first" };
		const secondModel = { provider: "anthropic", id: "loop-second" };
		const models = [baseModel, firstModel, secondModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const first = pi.commands.get("first");
		assert.ok(first);
		await first.handler("", ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/loop-first"]);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-1", { command: "second" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/loop-first", "anthropic/base-model", "anthropic/loop-second"]);
	});
});

test("inline prompt restore true restores model and thinking on prompt turn agent_end", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "deslop.md"),
			`---
model: anthropic/target-model
thinking: high
restore: true
---
TASK:$@`,
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);

		let ctxRef: any;
		let agentEndDuringPrompt = false;
		const { ctx } = createContext(cwd, pi, models, {
			waitForIdle: async () => {
				agentEndDuringPrompt = true;
				assert.deepEqual(pi.setModelCalls, ["anthropic/target-model"]);
				assert.deepEqual(pi.thinkingCalls, ["high"]);
				await pi.emit("agent_end", {}, ctxRef);
				assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
				assert.deepEqual(pi.thinkingCalls, ["high", "medium"]);
			},
		});
		ctxRef = ctx;
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);

		assert.equal(agentEndDuringPrompt, true);
		assert.deepEqual(pi.userMessages, ["TASK:demo"]);
		assert.deepEqual(pi.currentModel, baseModel);
		assert.equal(pi.getThinkingLevel(), "medium");

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
		assert.deepEqual(pi.thinkingCalls, ["high", "medium"]);
	});
});

test("inline prompt restore false leaves model and thinking active after prompt turn agent_end", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "deslop.md"),
			`---
model: anthropic/target-model
thinking: high
restore: false
---
TASK:$@`,
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);

		let ctxRef: any;
		const { ctx } = createContext(cwd, pi, models, {
			waitForIdle: async () => {
				await pi.emit("agent_end", {}, ctxRef);
			},
		});
		ctxRef = ctx;
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);

		assert.deepEqual(pi.userMessages, ["TASK:demo"]);
		assert.deepEqual(pi.currentModel, targetModel);
		assert.equal(pi.getThinkingLevel(), "high");

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model"]);
		assert.deepEqual(pi.thinkingCalls, ["high"]);
	});
});

test("idle agent_end does not read context model when no restore or tool command is pending", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		let modelReads = 0;
		const idleCtx = Object.create(ctx, {
			model: {
				get() {
					modelReads++;
					throw new Error("idle agent_end read ctx.model");
				},
			},
		});

		await pi.emit("agent_end", {}, idleCtx);

		assert.equal(modelReads, 0);
	});
});

test("prompt loop does not report completion when execution throws mid-run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nTASK:$@`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw new Error("mid-loop-crash");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await assert.rejects(deslop.handler("", ctx), /mid-loop-crash/);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("prompt loop preserves falsy thrown errors and suppresses completion", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nTASK:$@`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw 0;
			},
		});
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await assert.rejects(deslop.handler("", ctx), (error) => error === 0);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("loop restore uses runtime model state even when command context model is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\n---\nARGS:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 1", staleCtx);
		assert.deepEqual(pi.currentModel, baseModel);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
	});
});

test("chain loop does not report completion when execution throws mid-run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 2\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw new Error("mid-loop-crash");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await assert.rejects(pipeline.handler("", ctx), /mid-loop-crash/);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("chain loop preserves falsy thrown errors and suppresses completion", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 2\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw 0;
			},
		});
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await assert.rejects(pipeline.handler("", ctx), (error) => error === 0);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("chain execution restores model after unexpected step failure", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: anthropic/target-model\n---\nworker");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models, {
			waitForIdle: async () => {
				throw new Error("step-failure");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await assert.rejects(chainPrompts.handler("worker", ctx), /step-failure/);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
		assert.deepEqual(pi.currentModel, baseModel);
	});
});

test("chain cleanup runs even when restore throws", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: anthropic/target-model\nskill: tmux\n---\nworker");
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: helper\n---\nUse tmux.");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		pi.setModel = async (model: { provider: string; id: string }) => {
			pi.setModelCalls.push(`${model.provider}/${model.id}`);
			if (model.id === "base-model") throw new Error("restore-crash");
			pi.currentModel = model;
			return true;
		};

		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await assert.rejects(chainPrompts.handler("worker", ctx), /restore-crash/);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		assert.match(String(beforeStart.systemPrompt ?? ""), /run-prompt tool is available/i);
		assert.equal("message" in beforeStart, false);
	});
});

test("boomerang frontmatter collapses a prompt-template-model command after execution", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "review"\nboomerang: true\n---\nCHECK:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const branching = createBranchingContext(cwd, pi, [ACTIVE_MODEL]);
		let collapseSummary = "";
		let navigateCount = 0;
		let flagDuringNavigation: boolean | undefined;
		branching.ctx.navigateTree = async (targetId: string) => {
			navigateCount++;
			flagDuringNavigation = (globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress;
			const result = await pi.emitWithResult(
				"session_before_tree",
				{
					preparation: {
						targetId,
						entriesToSummarize: branching.branch.slice(1),
					},
				},
				branching.ctx,
			);
			collapseSummary = String((result?.summary as { summary?: string } | undefined)?.summary ?? "");
			return { cancelled: false };
		};
		branching.queueAssistantText("Fixed 1 issue.");
		await pi.emit("session_start", {}, branching.ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("src/index.ts", branching.ctx);

		assert.deepEqual(pi.userMessages, ["CHECK:src/index.ts"]);
		assert.equal(navigateCount, 1);
		assert.equal(flagDuringNavigation, true);
		assert.equal((globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress, false);
		assert.match(collapseSummary, /^\[Boomerang\]/);
		assert.match(collapseSummary, /Task: "double-check"/);
		assert.match(collapseSummary, /Outcome: Fixed 1 issue\./);
	});
});

test("boomerang frontmatter still collapses when the prompt is looped", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\nboomerang: true\n---\nCHECK:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const branching = createBranchingContext(cwd, pi, [ACTIVE_MODEL]);
		let collapseSummary = "";
		let navigateCount = 0;
		branching.ctx.navigateTree = async (targetId: string) => {
			navigateCount++;
			const result = await pi.emitWithResult(
				"session_before_tree",
				{
					preparation: {
						targetId,
						entriesToSummarize: branching.branch.slice(1),
					},
				},
				branching.ctx,
			);
			collapseSummary = String((result?.summary as { summary?: string } | undefined)?.summary ?? "");
			return { cancelled: false };
		};
		branching.queueAssistantText("First pass fixed one issue.");
		branching.queueAssistantText("Second pass found no more issues.");
		await pi.emit("session_start", {}, branching.ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("src/index.ts --loop 2 --no-converge", branching.ctx);

		assert.deepEqual(pi.userMessages, ["[Loop 1/2]\n\nCHECK:src/index.ts", "[Loop 2/2]\n\nCHECK:src/index.ts"]);
		assert.equal(navigateCount, 1);
		assert.match(collapseSummary, /^\[Boomerang\]/);
		assert.match(collapseSummary, /Outcome: Second pass found no more issues\./);
	});
});

test("fresh loop summaries are preserved when a looped boomerang collapses", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\nboomerang: true\n---\nCHECK:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const branching = createBranchingContext(cwd, pi, [ACTIVE_MODEL]);
		const collapseSummaries: string[] = [];
		branching.ctx.navigateTree = async (targetId: string) => {
			const result = await pi.emitWithResult(
				"session_before_tree",
				{
					preparation: {
						targetId,
						entriesToSummarize: branching.branch.slice(1),
					},
				},
				branching.ctx,
			);
			collapseSummaries.push(String((result?.summary as { summary?: string } | undefined)?.summary ?? ""));
			return { cancelled: false };
		};
		branching.queueAssistantText("First pass fixed one issue.");
		branching.queueAssistantText("Second pass found no more issues.");
		await pi.emit("session_start", {}, branching.ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("src/index.ts --loop 2 --fresh --no-converge", branching.ctx);

		assert.equal(collapseSummaries.length, 2);
		assert.match(collapseSummaries[0]!, /^\[Loop iteration 1\/2\]/);
		assert.match(collapseSummaries[1]!, /^\[Loop iteration 1\/2\]/);
		assert.match(collapseSummaries[1]!, /---\n\n\[Boomerang\]/);
	});
});

test("prompt without model inherits current model for conditionals and skill injection", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), "---\nskill: tmux\n---\n<if-model is=\"anthropic/*\">KEEP<else>DROP</if-model>");
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: tmux helper\n---\nAlways use tmux.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL]);
		await pi.emit("session_start", {}, ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["KEEP"]);
		assert.deepEqual(pi.setModelCalls, []);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		const message = beforeStart.message as { customType?: string; content?: string } | undefined;
		assert.equal(message?.customType, "skill-loaded");
		assert.match(message?.content ?? "", /Always use tmux\./);
	});
});

test("model-less prompt uses tracked runtime model even when command context model is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "dc"\n---\n<if-model is="anthropic/target-model">TARGET<else>BASE</if-model>');

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		pi.currentModel = targetModel;
		await pi.emit("model_select", { model: targetModel, previousModel: baseModel, source: "set" }, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("", staleCtx);

		assert.deepEqual(pi.userMessages, ["TARGET"]);
		assert.deepEqual(pi.setModelCalls, []);
	});
});

test("queued model-less prompt uses agent-end runtime model when stored command context is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "dc"\n---\n<if-model is="anthropic/target-model">TARGET<else>BASE</if-model>');

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", staleCtx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-model-less", { command: "double-check" });

		pi.currentModel = targetModel;
		await pi.emit("agent_end", {}, ctx);

		assert.deepEqual(pi.userMessages, ["TARGET"]);
		assert.deepEqual(pi.setModelCalls, []);
	});
});

test("skill injects as before_agent_start message without mutating system prompt", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: tmux\n---\nTASK:$@`);
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: tmux helper\n---\nAlways use tmux.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.userMessages, ["TASK:demo"]);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		assert.equal("systemPrompt" in beforeStart, false);
		const message = beforeStart.message as
			| {
					customType?: string;
					content?: string;
					display?: boolean;
					details?: { skillName?: string; skillContent?: string; skillPath?: string };
			  }
			| undefined;
		assert.ok(message);
		assert.equal(message.customType, "skill-loaded");
		assert.equal(message.display, true);
		assert.match(message.content ?? "", /<skill name="tmux">/);
		assert.match(message.content ?? "", /Always use tmux\./);
		assert.equal(message.details?.skillName, "tmux");
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
	});
});

test("multiple skills inject as separate blocks in one atomic context message", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "audit"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: [tmux, skill:audit]\n---\nTASK:$@`);
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\n---\nUse tmux.");
		writeFileSync(join(root, ".pi", "agent", "skills", "audit", "SKILL.md"), "---\nname: audit\n---\nUse audit.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands.get("deslop")!.handler("demo", ctx);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		const message = beforeStart?.message as {
			content?: string;
			details?: { skillName?: string; skills?: Array<{ skillName: string; skillPath: string }> };
		} | undefined;
		assert.match(message?.content ?? "", /<skill name="tmux">\nUse tmux\.\n<\/skill>\n\n<skill name="audit">\nUse audit\.\n<\/skill>/);
		assert.equal(message?.details?.skillName, "tmux");
		assert.deepEqual(message?.details?.skills?.map((skill) => skill.skillName), ["tmux", "audit"]);
	});
});

test("multiple skill resolution aborts atomically when a later skill is missing", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\nskill: tmux, missing-skill\n---\nTASK:$@");
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\n---\nUse tmux.");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [baseModel, targetModel]);
		await pi.emit("session_start", {}, ctx);
		await pi.commands.get("deslop")!.handler("demo", ctx);

		assert.deepEqual(pi.setModelCalls, []);
		assert.deepEqual(pi.userMessages, []);
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
		assert.match(getNotifications().join("\n"), /Skill "missing-skill" not found/);
	});
});

test("skill resolves from registered skill commands and supports skill: prefix", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		const skillPath = join(root, "custom-skills", "external-skill.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, "custom-skills"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: skill:external-skill\n---\nTASK:$@`);
		writeFileSync(skillPath, "---\nname: external-skill\ndescription: external\n---\nUse external skill.");

		const pi = new FakePi();
		pi.skillCommands = [{ name: "skill:external-skill", source: "skill", sourceInfo: { path: skillPath } }];
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.userMessages, ["TASK:demo"]);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		const message = beforeStart.message as { content?: string; details?: { skillName?: string; skillPath?: string } } | undefined;
		assert.ok(message);
		assert.match(message.content ?? "", /Use external skill\./);
		assert.equal(message.details?.skillName, "external-skill");
		assert.equal(message.details?.skillPath, skillPath);
	});
});

test("missing skill aborts before model switch and before_agent_start injection", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\nskill: missing-skill\n---\nTASK:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.setModelCalls, []);
		assert.deepEqual(pi.currentModel, baseModel);
		assert.deepEqual(pi.userMessages, []);
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
		assert.match(getNotifications().join("\n"), /Skill "missing-skill" not found/);
	});
});

test("skill path traversal names are rejected", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: ..\n---\nTASK:$@`);
		writeFileSync(join(cwd, ".pi", "SKILL.md"), "Unexpected traversal target");

		const pi = new FakePi();
		pi.skillCommands = [{ name: "skill:..", source: "skill", sourceInfo: { path: join(cwd, ".pi", "SKILL.md") } }];
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.userMessages, []);
		assert.match(getNotifications().join("\n"), /Skill "\.\." not found/);
	});
});

test("session switch clears queued skill message", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: tmux\n---\nTASK:$@`);
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: tmux helper\n---\nAlways use tmux.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
			await pi.emit("session_start", { reason: "resume" }, ctx);
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
	});
});

test("session switch clears pending restore state", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\nrestore: true\n---\nTASK:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model"]);
			await pi.emit("session_start", { reason: "resume" }, ctx);
		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model"]);
	});
});

test("chain template chainContext summary prepends previous-step summary to second delegated step", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: analyze -> fix\nchainContext: summary\n---\nignored');
			writeFileSync(join(cwd, ".pi", "prompts", "analyze.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nANALYZE`);
			writeFileSync(join(cwd, ".pi", "prompts", "fix.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFIX`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				tasks.push(request.task);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `done ${tasks.length}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("pipeline")!.handler("", ctx);
			assert.equal(tasks.length, 2);
			assert.match(tasks[1] ?? "", /^\[Previous chain steps\]\n\nStep 1 — analyze:/);
		});
	});
});

test("chain-prompts --chain-context prepends previous-step summary to second delegated step", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "analyze.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nANALYZE`);
			writeFileSync(join(cwd, ".pi", "prompts", "fix.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFIX`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				tasks.push(request.task);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `done ${tasks.length}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("chain-prompts")!.handler("analyze -> fix --chain-context", ctx);
			assert.equal(tasks.length, 2);
			assert.match(tasks[1] ?? "", /^\[Previous chain steps\]\n\nStep 1 — analyze:/);
		});
	});
});

test("per-step --with-context only affects that delegated step", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "one.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nONE`);
			writeFileSync(join(cwd, ".pi", "prompts", "two.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nTWO`);
			writeFileSync(join(cwd, ".pi", "prompts", "three.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nTHREE`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				tasks.push(request.task);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `done ${tasks.length}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("chain-prompts")!.handler("one -> two --with-context -> three", ctx);
			assert.equal(tasks.length, 3);
			assert.match(tasks[1] ?? "", /^\[Previous chain steps\]\n\nStep 1 — one:/);
			assert.doesNotMatch(tasks[2] ?? "", /^\[Previous chain steps\]/);
		});
	});
});

test("first delegated chain step never receives a summary preamble", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "analyze.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nANALYZE`);
			writeFileSync(join(cwd, ".pi", "prompts", "fix.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFIX`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				tasks.push(request.task);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `done ${tasks.length}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("chain-prompts")!.handler("analyze -> fix --chain-context", ctx);
			assert.doesNotMatch(tasks[0] ?? "", /^\[Previous chain steps\]/);
		});
	});
});

test("non-delegated steps do not receive summary preambles with chain context enabled", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "scan.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN`);
			writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\n---\nREVIEW`);

			const pi = new FakePi();
			const { ctx, queueAssistantText } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			queueAssistantText("review done");
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "scan done" }] }],
					isError: false,
				});
			});

			await pi.commands.get("chain-prompts")!.handler("scan -> review --chain-context", ctx);
			assert.deepEqual(
				pi.userMessages,
				["REVIEW", "[Delegated chain complete: scan -> review]\n\nscan done"],
			);
		});
	});
});

test("delegated inheritContext chain steps skip summary preambles", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "scan.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN`);
			writeFileSync(join(cwd, ".pi", "prompts", "fix.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\ninheritContext: true\n---\nFIX`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				tasks.push(request.task);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
					isError: false,
				});
			});

			await pi.commands.get("chain-prompts")!.handler("scan -> fix --chain-context", ctx);
			assert.equal(tasks[1], "FIX");
		});
	});
});

test("per-step loops contribute one combined step summary to the next step", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "worker --loop 2 -> follow"\nchainContext: summary\n---\nignored');
			writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nWORKER`);
			writeFileSync(join(cwd, ".pi", "prompts", "follow.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFOLLOW`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			let delegatedCount = 0;
			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCount++;
				tasks.push(request.task);
				const messages = delegatedCount <= 2
					? [
						{
							role: "assistant",
							content: [
								{ type: "toolCall", id: "w", name: "write", arguments: { path: `file-${delegatedCount}.ts` } },
								{ type: "text", text: `worker ${delegatedCount}` },
							],
						},
					]
					: [{ role: "assistant", content: [{ type: "text", text: "follow" }] }];
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages,
					isError: false,
				});
			});

			await pi.commands.get("pipeline")!.handler("", ctx);
			assert.equal(tasks.length, 3);
			const followTask = tasks[2] ?? "";
			assert.match(followTask, /^\[Previous chain steps\]\n\nStep 1 — worker:/);
			assert.equal((followTask.match(/Step 1 — worker:/g) ?? []).length, 1);
		});
	});
});

test("outer chain loop iterations reset summary scope", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "prompts", "pipeline.md"),
				'---\nchain: first -> second\nchainContext: summary\nloop: 2\nconverge: false\n---\nignored',
			);
			writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFIRST`);
			writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSECOND`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const tasks: string[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				tasks.push(request.task);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `done ${tasks.length}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("pipeline")!.handler("", ctx);
			assert.equal(tasks.length, 4);
			assert.doesNotMatch(tasks[0] ?? "", /^\[Previous chain steps\]/);
			assert.match(tasks[1] ?? "", /^\[Previous chain steps\]/);
			assert.doesNotMatch(tasks[2] ?? "", /^\[Previous chain steps\]/);
			assert.match(tasks[3] ?? "", /^\[Previous chain steps\]/);
		});
	});
});

test("parallel(scan-fe --with-context) is rejected by chain validation", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe --with-context) -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nscan`);
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nreview`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("pipeline")!.handler("", ctx);
		assert.match(getNotifications().join("\n"), /Step "scan-fe" in parallel\(\) does not support per-task --with-context\./);
	});
});

test("--model flag overrides prompt model for single execution", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\n---\nreview code`);

		const overrideModel = { provider: "anthropic", id: "claude-opus-4-6" };
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL, overrideModel]);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("review");
		assert.ok(command);
		await command.handler("--model=anthropic/claude-opus-4-6", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/claude-opus-4-6"]);
		assert.deepEqual(pi.userMessages, ["review code"]);
	});
});

test("--model flag overrides prompt model in loop iterations", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "fix.md"),
			`---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nfix bugs`,
		);

		const overrideModel = { provider: "openai", id: "gpt-5.4" };
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL, overrideModel]);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("fix");
		assert.ok(command);
		await command.handler("--model=openai/gpt-5.4", ctx);

		assert.equal(pi.setModelCalls[0], "openai/gpt-5.4");
		assert.equal(pi.userMessages.length, 2);
	});
});

test("--fork flag implies --subagent and sets inheritContext", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "check.md"), `---\nmodel: ${MODEL_ID}\n---\ncheck code`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("check");
		assert.ok(command);
		await command.handler("--fork", ctx);

		assert.equal(pi.userMessages.length, 0, "should not execute inline (delegation path taken)");
		const notifications = getNotifications().join("\n");
		assert.ok(notifications.length > 0, "should have attempted delegation");
	});
});

test("delegated single run injects result as user message", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSINGLE`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "single delegated result" }] }],
					isError: false,
				});
			});

			await pi.commands.get("simplify")!.handler("", ctx);

			assert.deepEqual(pi.userMessages, ["[Delegated result: simplify]\n\nsingle delegated result"]);
		});
	});
});

test("delegated loop injects last iteration result as user message", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nLOOP`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `delegated loop ${delegatedCall}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("simplify")!.handler("--loop 3 --no-converge", ctx);

			assert.deepEqual(
				pi.userMessages,
				["[Delegated loop completed 3 iteration(s): simplify]\n\ndelegated loop 3"],
			);
		});
	});
});

test("delegated loop and chain abort do not inject follow-up user messages", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "loop-abort.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nLOOP_ABORT`);
			writeFileSync(
				join(cwd, ".pi", "prompts", "chain-abort.md"),
				'---\nchain: worker\nloop: 2\nfresh: true\nconverge: false\n---\nignored',
			);
			writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nWORKER`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			ctx.navigateTree = async () => ({ cancelled: true });
			await pi.emit("session_start", {}, ctx);

			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "delegated aborted path" }] }],
					isError: false,
				});
			});

			await pi.commands.get("loop-abort")!.handler("--loop 3 --fresh --no-converge", ctx);
			await pi.commands.get("chain-abort")!.handler("", ctx);

			assert.equal(pi.userMessages.length, 0);
		});
	});
});

test("delegated loop error after prior success does not inject stale delegated text", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "loop-error.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nLOOP_ERROR`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				if (delegatedCall === 1) {
					pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
						...request,
						messages: [{ role: "assistant", content: [{ type: "text", text: "loop delegated success" }] }],
						isError: false,
					});
					return;
				}
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					isError: true,
					errorText: "delegated loop failure",
				});
			});

			await pi.commands.get("loop-error")!.handler("--loop 2 --no-converge", ctx);

			assert.equal(delegatedCall, 2);
			assert.equal(pi.userMessages.length, 0);
		});
	});
});

test("delegated chain error after prior success does not inject stale delegated text", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFIRST`);
			writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSECOND`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				if (delegatedCall === 1) {
					pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
						...request,
						messages: [{ role: "assistant", content: [{ type: "text", text: "chain delegated success" }] }],
						isError: false,
					});
					return;
				}
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					isError: true,
					errorText: "delegated chain failure",
				});
			});

			await pi.commands.get("chain-prompts")!.handler("first -> second", ctx);

			assert.equal(delegatedCall, 2);
			assert.equal(pi.userMessages.length, 0);
		});
	});
});

test("mixed delegated/inline chain injects only the last delegated text", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "scan.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN`);
			writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\n---\nINLINE REVIEW`);
			writeFileSync(join(cwd, ".pi", "prompts", "finalize.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nFINALIZE`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{
						role: "assistant",
						content: [{ type: "text", text: delegatedCall === 1 ? "scan delegated result" : "final delegated result" }],
					}],
					isError: false,
				});
			});

			await pi.commands.get("chain-prompts")!.handler("scan -> review -> finalize", ctx);

			assert.deepEqual(pi.userMessages[0], "INLINE REVIEW");
			assert.deepEqual(
				pi.userMessages[1],
				"[Delegated chain complete: scan -> review -> finalize]\n\nfinal delegated result",
			);
		});
	});
});

test("delegated loop convergence still triggers and injects after convergence evaluation", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nCONVERGE`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "stable delegated result" }] }],
					isError: false,
				});
			});

			await pi.commands.get("simplify")!.handler("--loop 5", ctx);

			assert.equal(delegatedCall, 1);
			assert.deepEqual(
				pi.userMessages,
				["[Delegated loop converged after 1 iteration(s): simplify]\n\nstable delegated result"],
			);
		});
	});
});

function parallelResponse(request: any) {
	const tasks = request.tasks ?? [{ agent: request.agent }];
	return {
		...request,
		parallelResults: tasks.map((t: any) => ({
			agent: t.agent ?? "delegate",
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			isError: false,
		})),
		isError: false,
	};
}

function singleResponse(request: any) {
	return {
		...request,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		isError: false,
	};
}

test("chain template worktree: true passes worktree flag to parallel subagent request", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "wt-pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\nworktree: true\n---\nignored');
			writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-FE`);
			writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-BE`);
			writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nREVIEW`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const requests: any[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				requests.push(request);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				const response = request.tasks ? parallelResponse(request) : singleResponse(request);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			});

			await pi.commands.get("wt-pipeline")!.handler("", ctx);
			assert.equal(requests.length, 2);
			assert.equal(requests[0].worktree, true, "parallel step should have worktree: true");
			assert.equal(requests[1].worktree, undefined, "sequential step should not have worktree");
		});
	});
});

test("chain-prompts --worktree passes worktree flag to parallel subagent request", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-FE`);
			writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-BE`);
			writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nREVIEW`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const requests: any[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				requests.push(request);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				const response = request.tasks ? parallelResponse(request) : singleResponse(request);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			});

			await pi.commands.get("chain-prompts")!.handler("parallel(scan-fe, scan-be) -> review --worktree", ctx);
			assert.equal(requests.length, 2);
			assert.equal(requests[0].worktree, true, "parallel step should have worktree: true");
			assert.equal(requests[1].worktree, undefined, "sequential step should not have worktree");
		});
	});
});

test("chain template CLI --worktree overrides missing frontmatter worktree", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "no-wt.md"), '---\nchain: "parallel(scan-fe, scan-be)"\n---\nignored');
			writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-FE`);
			writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-BE`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			const requests: any[] = [];
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				requests.push(request);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, parallelResponse(request));
			});

			await pi.commands.get("no-wt")!.handler("--worktree", ctx);
			assert.equal(requests.length, 1);
			assert.equal(requests[0].worktree, true);
		});
	});
});

test("chain-prompts --worktree warns when chain has no parallel steps", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "analyze.md"), `---\nmodel: ${MODEL_ID}\n---\nANALYZE`);
		writeFileSync(join(cwd, ".pi", "prompts", "fix.md"), `---\nmodel: ${MODEL_ID}\n---\nFIX`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("chain-prompts")!.handler("analyze -> fix --worktree", ctx);
		assert.ok(getNotifications().some((n) => n.includes("--worktree ignored")));
	});
});

test("parallel chain loops treat delegated worktree diffs as changes", async () => {
	await withTempHome(async (root) => {
		await withSubagentBridge(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be)"\n---\nignored');
			writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-FE`);
			writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSCAN-BE`);

			const pi = new FakePi();
			const { ctx } = createBranchingContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			let requestCount = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				requestCount++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					parallelResults: [
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "frontend done" }] }], isError: false },
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "backend done" }] }], isError: false },
					],
					contentText:
						requestCount === 1
							? "2/2 succeeded\n\n=== Parallel Task 1 (delegate) ===\nfrontend done\n\n=== Parallel Task 2 (delegate) ===\nbackend done\n\n=== Worktree Changes ===\n\n--- Task 1 (delegate): 1 file changed, +1 -0 ---"
							: "2/2 succeeded\n\n=== Parallel Task 1 (delegate) ===\nfrontend done\n\n=== Parallel Task 2 (delegate) ===\nbackend done",
					isError: false,
				});
			});

			await pi.commands.get("pipeline")!.handler("--loop 2", ctx);
			assert.equal(requestCount, 2);
		});
	});
});

test("an aborted invocation releases the busy flag instead of wedging the channel", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invoke.md"), `---\nmodel: ${MODEL_ID}\n---\ninvoked`);

		const pi = new FakePi();
		const acknowledgements: any[] = [];
		const finishedPayloads: any[] = [];
		pi.events.on(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, (payload) => acknowledgements.push(payload));
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => finishedPayloads.push(payload));
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		delete (ctx as any).waitForIdle;
		delete (ctx as any).navigateTree;

		// The turn never starts and the context is already aborted: the bounded wait
		// must give up rather than spin, so the finally clears promptActive.
		ctx.isIdle = () => true;
		const controller = new AbortController();
		controller.abort();
		(ctx as any).signal = controller.signal;
		await pi.emit("session_start", {}, ctx);

		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "abort-1",
			name: "invoke",
		});

		const deadline = Date.now() + 5000;
		while (finishedPayloads.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		assert.equal(acknowledgements.length, 1, "the first request is accepted");
		assert.equal(acknowledgements[0].accepted, true);
		assert.equal(finishedPayloads.length, 1, "the aborted run still reports a terminal event");
		assert.notEqual(finishedPayloads[0].status, "completed");

		// The real regression: a second request must not be refused as busy.
		pi.events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: "abort-2",
			name: "invoke",
		});
		assert.equal(acknowledgements.length, 2);
		assert.notEqual(
			acknowledgements[1].accepted === false && acknowledgements[1].reason,
			"busy",
			"an aborted run must not leave the invoke channel permanently busy",
		);
	});
});

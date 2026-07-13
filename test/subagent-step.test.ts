import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSubagentPromptStep } from "../subagent-step.ts";
import {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	getDelegatedLiveState,
} from "../subagent-runtime.ts";

function withDelegationBridge(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-step-"));
	return run(root).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

function createPi() {
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const customMessages: unknown[] = [];
	return {
		customMessages,
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = bus.get(channel) ?? [];
				handlers.push(handler);
				bus.set(channel, handlers);
				return () => {
					const current = bus.get(channel) ?? [];
					bus.set(channel, current.filter((entry) => entry !== handler));
				};
			},
		},
		sendMessage(message: unknown) {
			customMessages.push(message);
		},
	} as any;
}

function createCtx(cwd: string) {
	const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	return {
		cwd,
		hasUI: false,
		model,
		modelRegistry: {
			find(provider: string, id: string) {
				if (provider === model.provider && id === model.id) return model;
				return undefined;
			},
			getAll() {
				return [model];
			},
			getAvailable() {
				return [model];
			},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "token" };
				},
			isUsingOAuth() {
				return false;
			},
		},
		ui: {
			notify() {},
			onTerminalInput() {
				return () => {};
			},
			setStatus() {},
			setWorkingMessage() {},
			setWidget() {},
			theme: { fg(_t: string, text: string) { return text; }, bold(text: string) { return text; } },
		},
		sessionManager: {
			getLeafId() {
				return "leaf";
			},
			getBranch() {
				return [];
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {},
	} as any;
}

function createInteractiveCtx(cwd: string) {
	const ctx = createCtx(cwd);
	ctx.hasUI = true;
	let terminalHandler: ((input: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	ctx.ui.onTerminalInput = (handler: (input: string) => { consume?: boolean; data?: string } | undefined) => {
		terminalHandler = handler;
		return () => {
			if (terminalHandler === handler) terminalHandler = undefined;
		};
	};
	return {
		ctx,
		sendInput: (input: string) => terminalHandler?.(input),
	};
}

const prompt = {
	name: "simplify",
	description: "",
	content: "do work",
	models: ["anthropic/claude-sonnet-4-20250514"],
	restore: true,
	source: "project",
	filePath: "prompt.md",
	subagent: true,
} as any;

test("executeSubagentPromptStep returns delegated change info", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.ts" } },
							{ type: "text", text: "Done." },
						],
					},
				],
				isError: false,
			});
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(result?.changed, true);
		assert.equal(pi.customMessages.length, 1);
	});
});

test("executeSubagentPromptStep forwards prompt cwd to delegated request", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const delegatedCwd = join(root, "delegated-cwd");
		mkdirSync(delegatedCwd, { recursive: true });
		let requestCwd: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			requestCwd = request.cwd;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd: delegatedCwd },
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(requestCwd, delegatedCwd);
	});
});

test("executeSubagentPromptStep forwards custom agents to the loaded bridge", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(join(root, "host-project"));
		const delegatedCwd = join(root, "delegated-project");
		mkdirSync(delegatedCwd, { recursive: true });
		let requestAgent: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			requestAgent = request.agent;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, subagent: "special", cwd: delegatedCwd },
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(requestAgent, "special");
		assert.equal(result?.agent, "special");
	});
});

test("executeSubagentPromptStep forwards protocol v2 metadata, fallback models, thinking, and resolved skills", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		mkdirSync(join(root, ".pi", "skills", "audit"), { recursive: true });
		writeFileSync(join(root, ".pi", "skills", "audit", "SKILL.md"), "---\ntitle: Audit\n---\nAudit skill body");
		let request: any;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			request = data;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt: {
				...prompt,
				models: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-5.4"],
				thinking: "high",
				skills: ["audit"],
			},
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(request.protocolVersion, 2);
		assert.deepEqual(request.compatibility.capabilities, [
			"effective-primary-model",
			"requested-thinking",
			"ordered-fallback-models",
			"resolved-skills",
			"bounded-context-seed",
		]);
		assert.equal(request.model, "anthropic/claude-sonnet-4-20250514");
		assert.deepEqual(request.fallbackModels, ["openai/gpt-5.4"]);
		assert.equal(request.thinking, "high");
		assert.deepEqual(request.skills, [{ name: "audit", content: "Audit skill body", path: join(root, ".pi", "skills", "audit", "SKILL.md") }]);
		assert.equal(request.contextSeed, undefined);
	});
});

test("executeSubagentPromptStep adds bounded inherited context seed only for fork context", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		ctx.sessionManager.getBranch = () => [
			{
				type: "message",
				id: "u1",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "Please inspect this." },
			},
			{
				type: "message",
				id: "a1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden chain of thought" },
						{ type: "text", text: "I will inspect." },
						{ type: "toolCall", id: "1", name: "bash", arguments: { command: "curl https://example.invalid/secret", path: "/tmp/secret", value: "SENSITIVE_VALUE", secret: "SECRET_VALUE" } },
						{ type: "tool_use", id: "alt-1", name: "read", input: { path: "/tmp/alternate", value: "ALT_VALUE" } },
						{ toolCall: { name: "write", arguments: '{"path":"/tmp/container","secret":"CONTAINER_SECRET"}' } },
						{ type: "function", function: { name: "fetch", arguments: { command: "FUNCTION_COMMAND", secret: "FUNCTION_SECRET" } } },
						{ name: "custom", command: "MALFORMED_COMMAND", path: "/tmp/malformed", value: "MALFORMED_VALUE", secret: "MALFORMED_SECRET" },
					],
				},
			},
			{
				type: "message",
				id: "t1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "toolResult", toolName: "read", toolCallId: "1", content: [{ type: "text", text: "x".repeat(3000) }] },
			},
			{
				type: "message",
				id: "a2",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: { role: "assistant", content: [{ type: "toolCall", id: "2", name: "bash", arguments: { command: "npm test" } }] },
			},
		] as any;
		let request: any;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			request = data;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, inheritContext: true },
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(request.context, "fork");
		assert.equal(request.contextSeed.kind, "bounded-session-context");
		assert.equal(request.contextSeed.metadata.excludesThinking, true);
		assert.equal(request.contextSeed.metadata.excludesUnresolvedTrailingToolCalls, true);
		assert.equal(request.contextSeed.metadata.excludesToolCallArguments, true);
		assert.equal(request.contextSeed.metadata.maxToolResultChars, 2000);
		assert.equal(request.contextSeed.includedMessages, 3);
		assert.equal(request.contextSeed.omittedMessages, 0);
		assert.equal(request.contextSeed.maxMessages, 12);
		assert.equal(request.contextSeed.maxChars, 24000);
		assert.equal(request.contextSeed.messages.length, request.contextSeed.includedMessages);
		assert.ok(request.contextSeed.messages.length <= request.contextSeed.maxMessages);
		assert.ok(request.contextSeed.usedChars <= request.contextSeed.maxChars);
		assert.equal(request.contextSeed.truncated, true);
		assert.deepEqual(request.contextSeed.messages.map((message: any) => message.id), ["u1", "a1", "t1"]);
		assert.equal(request.contextSeed.messages[1].content.includes("hidden chain of thought"), false);
		assert.equal(
			request.contextSeed.messages[1].content,
			"I will inspect.\n[tool call: bash]\n[tool call: read]\n[tool call: write]\n[tool call: fetch]\n[tool call: custom]",
		);
		assert.match(request.contextSeed.messages[1].content, /\[tool call: bash\]/);
		for (const omitted of [
			"curl",
			"/tmp/secret",
			"SENSITIVE_VALUE",
			"SECRET_VALUE",
			"/tmp/alternate",
			"ALT_VALUE",
			"/tmp/container",
			"CONTAINER_SECRET",
			"FUNCTION_COMMAND",
			"FUNCTION_SECRET",
			"MALFORMED_COMMAND",
			"/tmp/malformed",
			"MALFORMED_VALUE",
			"MALFORMED_SECRET",
		]) {
			assert.equal(request.contextSeed.messages[1].content.includes(omitted), false, `${omitted} should be omitted from inherited context seed`);
		}
		assert.equal(request.contextSeed.messages[2].role, "toolResult");
		assert.equal(request.contextSeed.messages[2].truncated, true);
		assert.ok(request.contextSeed.messages[2].content.length <= request.contextSeed.metadata.maxToolResultChars);
	});
});

test("executeSubagentPromptStep fails on delegated error response", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				isError: true,
				errorText: "boom",
			});
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/boom/,
		);
	});
});

test("executeSubagentPromptStep fails when delegated response has no assistant text", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }] }],
				isError: false,
			});
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/no assistant text/i,
		);
	});
});

test("executeSubagentPromptStep fails immediately when no bridge is listening", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		// No listener registered for REQUEST_EVENT — simulates subagent extension
		// not loaded or shadowed by another extension with the same name.
		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/no loaded pi-subagents bridge responded/i,
		);
	});
});

test("executeSubagentPromptStep fast-fail error mentions the agent name", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			(error: Error) => {
				assert.match(error.message, /no loaded pi-subagents bridge responded/i);
				assert.match(error.message, /delegate/);
				assert.ok(!error.message.includes("do work"), "should not include prompt content in error");
				return true;
			},
		);
	});
});

test("executeSubagentPromptStep preserves missing-agent errors from the loaded bridge", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				isError: true,
				errorText: "Delegated subagent `missing` not found. Available agents: delegate, reviewer.",
			});
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt: { ...prompt, subagent: "missing" },
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/not found/i,
		);
	});
});

test("executeSubagentPromptStep emits cancel on escape in UI mode", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const { ctx, sendInput } = createInteractiveCtx(root);
		let cancelledRequestId: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
			cancelledRequestId = (data as { requestId?: string }).requestId;
		});

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			setTimeout(() => sendInput("\x1b"), 0);
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/cancelled/i,
		);
		assert.ok(cancelledRequestId);
	});
});

test("executeSubagentPromptStep emits cancel on abort signal", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const controller = new AbortController();
		let cancelledRequestId: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
			cancelledRequestId = (data as { requestId?: string }).requestId;
		});

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			setTimeout(() => controller.abort(), 0);
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
					signal: controller.signal,
				}),
			/cancelled/i,
		);
		assert.ok(cancelledRequestId);
	});
});

test("executeSubagentPromptStep delegates parallel prompts with per-task cwd, taskPrefix, and aggregate text", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const workerA = join(root, "worker-a");
		const workerB = join(root, "worker-b");
		mkdirSync(workerA, { recursive: true });
		mkdirSync(workerB, { recursive: true });
		const contentText = [
			"2/2 succeeded",
			"",
			"=== Parallel Task 1 (delegate) ===",
			"Frontend issues.",
			"",
			"=== Parallel Task 2 (reviewer) ===",
			"Backend issues.",
			"",
			"=== Worktree Changes ===",
			"",
			"--- Task 1 (delegate): 2 files changed, +2 -0 ---",
		].join("\n");
		let requestTasks: Array<{ agent: string; task: string; model?: string; cwd?: string }> | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			requestTasks = request.tasks;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{
						agent: "delegate",
						messages: [{ role: "assistant", content: [{ type: "text", text: "Frontend issues." }] }],
						isError: false,
					},
					{
						agent: "reviewer",
						messages: [
							{
								role: "assistant",
								content: [
									{ type: "toolCall", id: "2", name: "write", arguments: { path: "report.md" } },
									{ type: "text", text: "Backend issues." },
								],
							},
						],
						isError: false,
					},
				],
				contentText,
				isError: false,
			});
		});

		const result = await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt: { ...prompt, cwd: workerA }, args: [], taskPrefix: "[Parallel subagent 1/2]" },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer", cwd: workerB }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
			taskPreamble: "[Previous chain steps]",
		});

		assert.equal(Array.isArray(requestTasks), true);
		assert.equal(requestTasks?.length, 2);
		assert.deepEqual(requestTasks?.map((task) => task.agent), ["delegate", "reviewer"]);
		assert.deepEqual(requestTasks?.map((task) => task.model), ["anthropic/claude-sonnet-4-20250514", "anthropic/claude-sonnet-4-20250514"]);
		assert.equal(requestTasks?.[0]?.cwd, workerA);
		assert.equal(requestTasks?.[1]?.cwd, workerB);
		assert.equal(requestTasks?.[0]?.task, "[Parallel subagent 1/2]\n\n[Previous chain steps]\n\n---\n\ndo work");
		assert.equal(requestTasks?.[1]?.task, "[Previous chain steps]\n\n---\n\ndo work");
		assert.equal(result?.text, contentText);
		assert.equal(result?.changed, true);
		assert.equal((pi.customMessages[0] as { content: string }).content, contentText);
	});
});

test("executeSubagentPromptStep rejects mixed cwd values when worktree is enabled", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const workerA = join(root, "worker-a");
		const workerB = join(root, "worker-b");
		mkdirSync(workerA, { recursive: true });
		mkdirSync(workerB, { recursive: true });

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					worktree: true,
					parallel: [
						{ prompt: { ...prompt, cwd: workerA }, args: [] },
						{ prompt: { ...prompt, name: "review", subagent: "reviewer", cwd: workerB }, args: [] },
					],
					ctx,
					currentModel: ctx.model,
				}),
			/worktree enabled must share the same cwd/i,
		);
	});
});

test("executeSubagentPromptStep prefers aggregate parallel status over first-task tool status", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		ctx.hasUI = true;
		const statusLines: string[] = [];
		ctx.ui.setStatus = (key: string, value?: string) => {
			if (key === "prompt-subagent" && value) statusLines.push(value);
		};

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				currentTool: "read",
				currentToolArgs: "a.ts",
				toolCount: 1,
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", currentTool: "read", currentToolArgs: "a.ts" },
					{ index: 1, agent: "reviewer", status: "pending" },
				],
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "A" }] }], isError: false },
					{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }], isError: false },
				],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt, args: [] },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer" }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
		});

		assert.ok(statusLines.some((line) => line.includes("parallel 0/2 running")));
		assert.equal(statusLines.some((line) => line.includes("running read")), false);
	});
});

test("executeSubagentPromptStep keeps single-task status running between tool calls", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		ctx.hasUI = true;
		const statusLines: string[] = [];
		ctx.ui.setStatus = (key: string, value?: string) => {
			if (key === "prompt-subagent" && value) statusLines.push(value);
		};

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				toolCount: 1,
				taskProgress: [{ index: 0, agent: "delegate", status: "running" }],
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.ok(statusLines.some((line) => line.includes("delegating to delegate · running")));
		assert.equal(statusLines.some((line) => line.includes("completed 1 tool")), false);
	});
});

test("executeSubagentPromptStep avoids duplicating single-task output lines from mirrored progress payloads", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let capturedOutput: string[] = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				recentOutputLines: ["single-a", "single-b"],
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["single-a", "single-b"] },
				],
			});
			capturedOutput = getDelegatedLiveState(request.requestId)?.recentOutput ?? [];
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.deepEqual(capturedOutput, ["single-a", "single-b"]);
	});
});

test("executeSubagentPromptStep keeps identical consecutive output lines from different parallel tasks", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let capturedOutput: string[] = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["same-line"] },
					{ index: 1, agent: "reviewer", status: "running", recentOutputLines: ["same-line"] },
				],
			});
			capturedOutput = getDelegatedLiveState(request.requestId)?.recentOutput ?? [];
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "A" }] }], isError: false },
					{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }], isError: false },
				],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt, args: [] },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer" }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
		});

		assert.deepEqual(capturedOutput, ["same-line", "same-line"]);
	});
});

test("executeSubagentPromptStep avoids duplicating unchanged task output lines across updates", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let capturedOutput: string[] = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["task0-a"] },
					{ index: 1, agent: "reviewer", status: "running", recentOutputLines: ["task1-a"] },
				],
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["task0-a"] },
					{ index: 1, agent: "reviewer", status: "running", recentOutputLines: ["task1-a", "task1-b"] },
				],
			});
			capturedOutput = getDelegatedLiveState(request.requestId)?.recentOutput ?? [];
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "A" }] }], isError: false },
					{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }], isError: false },
				],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt, args: [] },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer" }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
		});

		assert.deepEqual(capturedOutput, ["task0-a", "task1-a", "task1-b"]);
	});
});

test("executeSubagentPromptStep keeps parallel output history when top-level progress includes recentOutputLines", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let capturedOutput: string[] = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				recentOutputLines: ["task0-a"],
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["task0-a"] },
					{ index: 1, agent: "reviewer", status: "running", recentOutputLines: ["task1-a"] },
				],
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				recentOutputLines: ["task0-a"],
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", recentOutputLines: ["task0-a"] },
					{ index: 1, agent: "reviewer", status: "running", recentOutputLines: ["task1-a", "task1-b", "task1-c"] },
				],
			});
			capturedOutput = getDelegatedLiveState(request.requestId)?.recentOutput ?? [];
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "A" }] }], isError: false },
					{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }], isError: false },
				],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt, args: [] },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer" }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
		});

		assert.deepEqual(capturedOutput, ["task0-a", "task1-a", "task1-b", "task1-c"]);
	});
});

test("executeSubagentPromptStep preserves per-task model metadata when updates omit model", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let capturedModels: Array<string | undefined> = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", model: "openai/gpt-5-mini" },
					{ index: 1, agent: "reviewer", status: "running", model: "anthropic/claude-sonnet-4-20250514" },
				],
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, {
				requestId: request.requestId,
				taskProgress: [
					{ index: 0, agent: "delegate", status: "running", model: undefined },
					{ index: 1, agent: "reviewer", status: "running", model: undefined },
				],
			});
			capturedModels = (getDelegatedLiveState(request.requestId)?.taskProgress ?? []).map((entry) => entry.model);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "A" }] }], isError: false },
					{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }], isError: false },
				],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt, args: [] },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer" }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
		});

		assert.deepEqual(capturedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4-20250514"]);
	});
});

test("executeSubagentPromptStep fails on parallel task errors", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{
						agent: "delegate",
						messages: [],
						isError: true,
						errorText: "scan failed",
					},
				],
				isError: false,
			});
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					parallel: [{ prompt, args: [] }],
					ctx,
					currentModel: ctx.model,
				}),
			/scan failed/i,
		);
	});
});

test("executeSubagentPromptStep prepends taskPreamble for delegated single tasks", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTask = "";
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTask = request.task;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
			taskPreamble: "[Previous chain steps]\n\nStep 1 — analyze:\nOutcome: done",
		});

		assert.equal(delegatedTask, "[Previous chain steps]\n\nStep 1 — analyze:\nOutcome: done\n\n---\n\ndo work");
	});
});

test("executeSubagentPromptStep prepends taskPreamble for every delegated parallel task", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTasks: string[] = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTasks = (request.tasks ?? []).map((task: { task: string }) => task.task);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "A" }] }], isError: false },
					{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }], isError: false },
				],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			parallel: [
				{ prompt, args: [] },
				{ prompt: { ...prompt, name: "review", subagent: "reviewer" }, args: [] },
			],
			ctx,
			currentModel: ctx.model,
			taskPreamble: "[Previous chain steps]\n\nStep 1 — scan:\nOutcome: done",
		});

		assert.deepEqual(delegatedTasks, [
			"[Previous chain steps]\n\nStep 1 — scan:\nOutcome: done\n\n---\n\ndo work",
			"[Previous chain steps]\n\nStep 1 — scan:\nOutcome: done\n\n---\n\ndo work",
		]);
	});
});

test("executeSubagentPromptStep ignores taskPreamble when inheritContext is true", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTask = "";
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTask = request.task;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, inheritContext: true },
			args: [],
			ctx,
			currentModel: ctx.model,
			taskPreamble: "[Previous chain steps]\n\nStep 1 — analyze:\nOutcome: done",
		});

		assert.equal(delegatedTask, "do work");
	});
});

test("executeSubagentPromptStep keeps task unchanged when taskPreamble is omitted", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTask = "";
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTask = request.task;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(delegatedTask, "do work");
	});
});

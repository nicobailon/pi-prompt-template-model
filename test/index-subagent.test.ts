import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.ts";
import {
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
} from "../subagent-runtime.ts";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

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
			for (const handler of this.bus.get(channel) ?? []) handler(data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? [];
			handlers.push(handler);
			this.bus.set(channel, handlers);
			return () => {
				const current = this.bus.get(channel) ?? [];
				this.bus.set(channel, current.filter((entry) => entry !== handler));
			};
		},
	};
	currentModel = MODEL;
	setModelCalls: string[] = [];
	userMessages: string[] = [];
	customMessages: any[] = [];

	registerMessageRenderer() {}
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, command); }
	registerTool(tool: FakeTool) { this.tools.set(tool.name, tool); }
	getCommands() { return []; }
	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}
	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) await handler(payload, ctx);
	}
	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage(content: string) { this.userMessages.push(content); }
	sendMessage(message: any) { this.customMessages.push(message); }
}

function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-index-"));
	const prevHome = process.env.HOME;
	process.env.HOME = root;
	return run(root).finally(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(root, { recursive: true, force: true });
	});
}

function createContext(cwd: string, pi: FakePi) {
	const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }];
	let entryCount = 0;
	const nextId = (prefix: string) => `${prefix}-${++entryCount}`;
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
		pi.customMessages.push(message);
		branch.push({
			id: nextId("custom"),
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	};

	return {
		ctx: {
			cwd,
			hasUI: false,
			model: MODEL,
			modelRegistry: {
				find(provider: string, id: string) {
					return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined;
				},
				getAll() { return [MODEL]; },
				getAvailable() { return [MODEL]; },
					async getApiKeyAndHeaders() { return { ok: true, apiKey: "token" }; },
				isUsingOAuth() { return false; },
			},
			ui: {
				notify() {},
				onTerminalInput() { return () => {}; },
				setStatus() {},
				setWorkingMessage() {},
				theme: { fg(_token: string, text: string) { return text; } },
			},
			isIdle() { return false; },
			async waitForIdle() {},
			sessionManager: {
				getLeafId() { return branch[branch.length - 1]?.id ?? "root"; },
				getBranch() { return branch; },
			},
			async navigateTree() { return { cancelled: false }; },
		},
		branch,
	};
}

function respondWithDelegatedResult(pi: FakePi, setup?: (request: any) => void) {
	pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
		const request = payload as any;
		setup?.(request);
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
			...request,
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/file.ts" } },
						{ type: "text", text: "Done" },
					],
				},
			],
			isError: false,
		});
	});
}

function respondWithParallelDelegatedResult(pi: FakePi, setup?: (request: any) => void) {
	pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
		const request = payload as any;
		setup?.(request);
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
			...request,
			parallelResults: (request.tasks ?? []).map((task: any, index: number) => ({
				agent: task.agent,
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: `${index + 1}`, name: "write", arguments: { path: `src/${index + 1}.ts` } },
							{ type: "text", text: `Done ${index + 1}` },
						],
					},
				],
				isError: false,
			})),
			isError: false,
		});
	});
}

test("delegated prompts honor default agent, runtime override, and inheritContext", async () => {
	await withTempHome(async (root) => {
		const cases = [
			{
				name: "default",
				frontmatter: "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork",
				args: "",
				checkRequest(request: any) {
					assert.equal(request.agent, "delegate");
					assert.equal(request.context, "fresh");
				},
				after(pi: FakePi) {
					assert.deepEqual(pi.setModelCalls, []);
					assert.equal(pi.customMessages.length, 1);
				},
			},
			{
				name: "override",
				frontmatter: "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: worker\n---\nwork",
				args: "--subagent:reviewer",
				checkRequest(request: any) {
					assert.equal(request.agent, "reviewer");
				},
			},
			{
				name: "fork",
				frontmatter: "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\ninheritContext: true\n---\nwork",
				args: "",
				checkRequest(request: any) {
					assert.equal(request.context, "fork");
				},
			},
		] as const;

		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), testCase.frontmatter);

			const pi = new FakePi();
			const { ctx } = createContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);
			respondWithDelegatedResult(pi, (request) => {
				testCase.checkRequest(request);
			});

			await pi.commands.get("simplify")!.handler(testCase.args, ctx);
			testCase.after?.(pi);
		}
	});
});

test("parallel delegated prompts expand to repeated tasks with slot headers", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "simplify-parallel.md"),
			"---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: simplifier\ninheritContext: true\nparallel: 3\nworktree: true\n---\nReview changed files and fix issues.",
		);

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithParallelDelegatedResult(pi, (request) => {
			assert.equal(request.context, "fork");
			assert.equal(request.worktree, true);
			assert.equal(request.tasks?.length, 3);
			assert.deepEqual(
				request.tasks?.map((task: { agent: string }) => task.agent),
				["simplifier", "simplifier", "simplifier"],
			);
			assert.match(request.tasks?.[0]?.task ?? "", /^\[Parallel subagent 1\/3\]\n\nReview changed files and fix issues\.$/);
			assert.match(request.tasks?.[1]?.task ?? "", /^\[Parallel subagent 2\/3\]\n\nReview changed files and fix issues\.$/);
			assert.match(request.tasks?.[2]?.task ?? "", /^\[Parallel subagent 3\/3\]\n\nReview changed files and fix issues\.$/);
		});

		await pi.commands.get("simplify-parallel")!.handler("", ctx);
		assert.equal(pi.customMessages.length, 1);
		assert.match(pi.customMessages[0].content, /=== Parallel Task 1 \(simplifier\) ===/);
	});
});

test("delegated loops converge from delegated write/no-write changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let call = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			call++;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [
					{
						role: "assistant",
						content: call === 1
							? [{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/a.ts" } }, { type: "text", text: "changed" }]
							: [{ type: "text", text: "no changes" }],
					},
				],
				isError: false,
			});
		});

		await pi.commands.get("simplify")!.handler("--loop 5", ctx);
		assert.equal(call, 2);
	});
});

test("queued run-prompt executes delegated commands", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithDelegatedResult(pi);

		await pi.commands.get("prompt-tool")!.handler("on", ctx);
		await pi.tools.get("run-prompt")!.execute("tool-1", { command: "simplify" });
		await pi.emit("agent_end", {}, ctx);

		assert.equal(pi.customMessages.length, 1);
	});
});

test("parallel chain step delegates with tasks payload", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be)"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: delegate\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: reviewer\n---\nscan be");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let requestTasks: Array<{ agent: string; task: string; model?: string }> | undefined;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			requestTasks = request.tasks;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{
						agent: "delegate",
						messages: [{ role: "assistant", content: [{ type: "text", text: "fe done" }] }],
						isError: false,
					},
					{
						agent: "reviewer",
						messages: [{ role: "assistant", content: [{ type: "text", text: "be done" }] }],
						isError: false,
					},
				],
				isError: false,
			});
		});

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(Array.isArray(requestTasks), true);
		assert.equal(requestTasks?.length, 2);
		assert.equal(requestTasks?.[0]?.agent, "delegate");
		assert.equal(requestTasks?.[1]?.agent, "reviewer");
		assert.equal(pi.customMessages.length, 1);
		assert.equal(pi.userMessages.length, 1);
		assert.equal(
			pi.userMessages[0],
			"[Delegated chain complete: parallel(scan-fe, scan-be)]\n\n=== Parallel Task 1 (delegate) ===\nfe done\n\n=== Parallel Task 2 (reviewer) ===\nbe done",
		);
	});
});

test("parallel chain task failure aborts remaining chain steps", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nreview");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
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
					{ agent: "delegate", messages: [], isError: true, errorText: "scan failed" },
					{ agent: "delegate", messages: [], isError: false },
				],
				isError: false,
			});
		});

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(requestCount, 1);
		assert.equal(pi.userMessages.length, 0);
		assert.equal(pi.customMessages.length, 0);
	});
});

test("successful parallel step continues to next sequential step", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nreview findings");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "fe done" }] }], isError: false },
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "be done" }] }], isError: false },
				],
				isError: false,
			});
		});

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(pi.customMessages.length, 1);
		assert.equal(pi.userMessages.length, 2);
		assert.equal(pi.userMessages[0], "review findings");
		assert.equal(
			pi.userMessages[1],
			"[Delegated chain complete: parallel(scan-fe, scan-be) -> review]\n\n=== Parallel Task 1 (delegate) ===\nfe done\n\n=== Parallel Task 2 (delegate) ===\nbe done",
		);
	});
});

test("parallel delegated step summaries are passed to the next delegated sequential step", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\nchainContext: summary\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nreview findings");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		const delegatedTasks: string[] = [];
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			delegatedTasks.push(request.task);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			if (request.tasks) {
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					parallelResults: [
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "fe done" }] }], isError: false },
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "be done" }] }], isError: false },
					],
					isError: false,
				});
				return;
			}
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "review done" }] }],
				isError: false,
			});
		});

		await pi.commands.get("pipeline")!.handler("", ctx);
		assert.equal(delegatedTasks.length, 2);
		assert.match(delegatedTasks[1] ?? "", /^\[Previous chain steps\]\n\nStep 1 — parallel\(scan-fe, scan-be\):/);
	});
});

test("chain-prompts CLI command handles parallel() syntax", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let requestTasks: Array<{ agent: string; task: string }> | undefined;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			requestTasks = request.tasks;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "fe" }] }], isError: false },
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "be" }] }], isError: false },
				],
				isError: false,
			});
		});

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("parallel(scan-fe, scan-be)", ctx);

		assert.equal(Array.isArray(requestTasks), true);
		assert.equal(requestTasks?.length, 2);
		assert.equal(pi.customMessages.length, 1);
	});
});

test("compare prompt expands count, applies taskSuffix, and runs a final applier after partial reviewer success", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "compare.md"),
			[
				"---",
				"bestOfN:",
				"  workers:",
				"    - subagent: true",
				"      model: anthropic/claude-sonnet-4-20250514:high",
				"      taskSuffix: Save findings to `.compare-findings/w1.md`.",
				"      count: 2",
				"    - subagent: delegate",
				"  reviewers:",
				"    - subagent: true",
				"      taskSuffix: Mention `.compare-findings/w1.md` in the recommendation.",
				"      count: 2",
				"  finalApplier:",
				"    subagent: reviewer",
				"    model: anthropic/claude-sonnet-4-20250514:xhigh",
				"    taskSuffix: Apply the best patch and report verification.",
				"  worktree: true",
				"---",
				"Implement: $@",
			].join("\n"),
		);

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let phase = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			phase++;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			if (phase === 1) {
				assert.equal(request.tasks?.length, 3);
				assert.deepEqual(request.tasks?.map((task: any) => task.agent), ["delegate", "delegate", "delegate"]);
				assert.deepEqual(
					request.tasks?.map((task: any) => task.model),
					[
						"anthropic/claude-sonnet-4-20250514",
						"anthropic/claude-sonnet-4-20250514",
						"anthropic/claude-sonnet-4-20250514",
					],
				);
				assert.deepEqual(request.tasks?.map((task: any) => task.thinking), ["high", "high", undefined]);
				assert.match(request.tasks?.[0]?.task ?? "", /^Implement: fix bug\n\nSave findings to `\.compare-findings\/w1\.md`\.$/);
				assert.match(request.tasks?.[1]?.task ?? "", /^Implement: fix bug\n\nSave findings to `\.compare-findings\/w1\.md`\.$/);
				assert.match(request.tasks?.[2]?.task ?? "", /^Implement: fix bug$/);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					contentText: [
						"3/3 succeeded",
						"",
						"=== Task 1: delegate ===",
						"w1",
						"",
						"=== Task 2: delegate ===",
						"w2",
						"",
						"=== Task 3: delegate ===",
						"w3",
						"",
						"=== Worktree Changes ===",
						"",
						"--- Task 1 (delegate): 1 files changed, +1 -0 ---",
						"README.md | 1 +",
					].join("\n"),
					parallelResults: [
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "w1" }] }], isError: false },
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "w2" }] }], isError: false },
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "w3" }] }], isError: false },
					],
					isError: false,
				});
				return;
			}

			if (phase === 2) {
				assert.equal(request.tasks?.length, 2);
				assert.match(request.tasks?.[0]?.task ?? "", /\[Worker outputs and worktree summaries\]/);
				assert.match(request.tasks?.[0]?.task ?? "", /=== Worker 1 \(delegate, anthropic\/claude-sonnet-4-20250514\) ===\nw1/);
				assert.match(request.tasks?.[0]?.task ?? "", /=== Worktree Changes ===/);
				assert.match(request.tasks?.[0]?.task ?? "", /--- Task 1 \(delegate\): 1 files changed, \+1 -0 ---/);
				assert.match(request.tasks?.[0]?.task ?? "", /Mention `\.compare-findings\/w1\.md` in the recommendation\./);
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					parallelResults: [
						{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "Winner: worker 2" }] }], isError: false },
						{ agent: "reviewer", messages: [], isError: true, errorText: "quota" },
					],
					isError: false,
				});
				return;
			}

			assert.equal(phase, 3);
			assert.equal(request.agent, "reviewer");
			assert.equal(request.model, "anthropic/claude-sonnet-4-20250514");
			assert.equal(request.thinking, "xhigh");
			assert.equal(request.cwd, cwd);
			assert.equal(request.worktree, undefined);
			assert.equal(request.tasks, undefined);
			assert.match(request.task ?? "", /\[Worker outputs and worktree summaries\]/);
			assert.match(request.task ?? "", /=== Worker 1 \(delegate, anthropic\/claude-sonnet-4-20250514\) ===\nw1/);
			assert.match(request.task ?? "", /=== Worktree Changes ===/);
			assert.match(request.task ?? "", /\[Reviewer findings\]/);
			assert.match(request.task ?? "", /Winner: worker 2/);
			assert.match(request.task ?? "", /\[Reviewer failures\]/);
			assert.match(request.task ?? "", /quota/);
			assert.match(request.task ?? "", /Apply the best patch and report verification\./);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Final apply: combined worker 2 with worker 1 tests." }] }],
				isError: false,
			});
		});

		await pi.commands.get("compare")!.handler("fix bug", ctx);
		assert.equal(phase, 3);
		assert.equal(pi.userMessages.length, 1);
		assert.match(pi.userMessages[0]!, /\[Compare apply complete: compare\]/);
		assert.match(pi.userMessages[0]!, /Final apply: combined worker 2 with worker 1 tests\./);
	});
});

test("compare prompts handle partial-success policy, final-applier fallback, overrides, guardrails, and at-path cwd", async () => {
	await withTempHome(async (root) => {
		const cases = [
			{
				name: "compare-override",
				command: 'compare-override --workers=[{"agent":"delegate","count":2}] --reviewers-append=[{"agent":"reviewer","count":2}] fix',
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				handle(request: any, phase: number) {
					if (phase === 1) {
						assert.equal(request.tasks?.length, 2);
						assert.deepEqual(request.tasks?.map((task: any) => task.agent), ["delegate", "delegate"]);
						return {
							messages: [],
							contentText: [
								"1/2 succeeded",
								"",
								"=== Task 1: delegate ===",
								"failed output",
								"",
								"=== Task 2: delegate ===",
								"w2",
								"",
								"=== Worktree Changes ===",
								"",
								"--- Task 1 (delegate): 1 files changed, +1 -0 ---",
								"bad.txt | 1 +",
								"",
								"--- Task 2 (delegate): 1 files changed, +1 -0 ---",
								"good.txt | 1 +",
							].join("\n"),
							parallelResults: [
								{ agent: "delegate", messages: [], isError: true, errorText: "quota" },
								{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "w2" }] }], isError: false },
							],
							isError: false,
						};
					}
					assert.equal(request.tasks?.length, 3);
					assert.match(request.tasks?.[0]?.task ?? "", /\[Worker failures\]/);
					assert.match(request.tasks?.[0]?.task ?? "", /quota/);
					assert.match(request.tasks?.[0]?.task ?? "", /good\.txt \| 1 \+/);
					assert.doesNotMatch(request.tasks?.[0]?.task ?? "", /bad\.txt \| 1 \+/);
					return {
						messages: [],
						parallelResults: [
							{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "r1" }] }], isError: false },
							{ agent: "reviewer", messages: [], isError: true, errorText: "timeout" },
							{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "r3" }] }], isError: false },
						],
						isError: false,
					};
				},
				assert(pi: FakePi, phase: number) {
					assert.equal(phase, 2);
					assert.equal(pi.userMessages.length, 1);
					assert.match(pi.userMessages[0]!, /\[Compare review complete: compare-override\]/);
					assert.match(pi.userMessages[0]!, /r1/);
					assert.match(pi.userMessages[0]!, /r3/);
					assert.match(pi.userMessages[0]!, /\[Reviewer failures\]/);
					assert.doesNotMatch(pi.userMessages[0]!, /timeout.*timeout/s);
				},
			},
			{
				name: "compare-all-workers-fail",
				command: "compare-all-workers-fail fix",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				handle() {
					return {
						messages: [],
						parallelResults: [
							{ agent: "delegate", messages: [], isError: true, errorText: "worker failed" },
							{ agent: "delegate", messages: [], isError: true, errorText: "still failed" },
						],
						isError: false,
					};
				},
				assert(pi: FakePi, phase: number) {
					assert.equal(phase, 1);
					assert.equal(pi.userMessages.length, 0);
				},
			},
			{
				name: "compare-no-reviewer-success",
				command: "compare-no-reviewer-success fix",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"    - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				handle(_request: any, phase: number) {
					if (phase === 1) {
						return {
							messages: [],
							parallelResults: [{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "worker" }] }], isError: false }],
							isError: false,
						};
					}
					return {
						messages: [],
						parallelResults: [
							{ agent: "reviewer", messages: [], isError: true, errorText: "timeout" },
							{ agent: "reviewer", messages: [], isError: true, errorText: "quota" },
						],
						isError: false,
					};
				},
				assert(pi: FakePi, phase: number) {
					assert.equal(phase, 2);
					assert.equal(pi.userMessages.length, 0);
				},
			},
			{
				name: "compare-reviewer-fallback",
				command: "compare-reviewer-fallback fix",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"  finalApplier:",
					"    agent: reviewer",
					"    taskSuffix: Synthesize directly from workers if reviewers fail.",
					"  worktree: true",
					"---",
					"$@",
				].join("\n"),
				handle(request: any, phase: number) {
					if (phase === 1) {
						return {
							messages: [],
							parallelResults: [{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "worker" }] }], isError: false }],
							isError: false,
						};
					}
					if (phase === 2) {
						return {
							messages: [],
							parallelResults: [{ agent: "reviewer", messages: [], isError: true, errorText: "quota" }],
							isError: false,
						};
					}
					assert.equal(request.tasks, undefined);
					assert.equal(request.cwd, join(root, "compare-reviewer-fallback"));
					assert.equal(request.worktree, undefined);
					assert.match(request.task ?? "", /All reviewer runs failed\. Synthesize directly from the worker variants\./);
					assert.match(request.task ?? "", /\[Reviewer failures\]/);
					assert.match(request.task ?? "", /\[Reviewer findings\]/);
					assert.match(request.task ?? "", /Synthesize directly from workers if reviewers fail\./);
					return {
						messages: [{ role: "assistant", content: [{ type: "text", text: "Fallback final apply" }] }],
						isError: false,
					};
				},
				assert(pi: FakePi, phase: number) {
					assert.equal(phase, 3);
					assert.equal(pi.userMessages.length, 1);
					assert.match(pi.userMessages[0]!, /\[Compare apply complete: compare-reviewer-fallback\]/);
					assert.match(pi.userMessages[0]!, /Fallback final apply/);
				},
			},
			{
				name: "compare-final-applier-override",
				command: 'compare-final-applier-override --final-applier={"agent":"reviewer","model":"anthropic/claude-sonnet-4-20250514","taskSuffix":"Use runtime final apply override."} fix',
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"  worktree: true",
					"---",
					"$@",
				].join("\n"),
				handle(request: any, phase: number) {
					if (phase === 1) {
						return {
							messages: [],
							parallelResults: [{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "worker runtime" }] }], isError: false }],
							isError: false,
						};
					}
					if (phase === 2) {
						return {
							messages: [],
							parallelResults: [{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "review runtime" }] }], isError: false }],
							isError: false,
						};
					}
					assert.equal(request.agent, "reviewer");
					assert.equal(request.model, "anthropic/claude-sonnet-4-20250514");
					assert.equal(request.tasks, undefined);
					assert.equal(request.cwd, join(root, "compare-final-applier-override"));
					assert.equal(request.worktree, undefined);
					assert.match(request.task ?? "", /Use runtime final apply override\./);
					return {
						messages: [{ role: "assistant", content: [{ type: "text", text: "Runtime final apply" }] }],
						isError: false,
					};
				},
				assert(pi: FakePi, phase: number) {
					assert.equal(phase, 3);
					assert.equal(pi.userMessages.length, 1);
					assert.match(pi.userMessages[0]!, /\[Compare apply complete: compare-final-applier-override\]/);
					assert.match(pi.userMessages[0]!, /Runtime final apply/);
				},
			},
			{
				name: "compare-final-applier-guardrail",
				command: 'compare-final-applier-guardrail --final-applier={"agent":"reviewer"} fix',
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				handle() {
					assert.fail("worktree guardrail should reject before delegated execution");
					return { messages: [], isError: false };
				},
				assert(pi: FakePi, phase: number) {
					assert.equal(phase, 0);
					assert.equal(pi.userMessages.length, 0);
				},
			},
			{
				name: "parallel-patch-compare-at-path",
				command: `parallel-patch-compare-at-path ${join(root, "other-repo")} fix bug`,
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - agent: delegate",
					"  reviewers:",
					"    - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				handle(request: any, phase: number) {
					const repoPath = join(root, "other-repo");
					if (phase === 1) {
						assert.equal(request.cwd, repoPath);
						assert.equal(request.tasks?.[0]?.cwd, repoPath);
						assert.doesNotMatch(request.tasks?.[0]?.task ?? "", new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
						assert.match(request.tasks?.[0]?.task ?? "", /fix bug/);
						return {
							messages: [],
							parallelResults: [{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "worker" }] }], isError: false }],
							isError: false,
						};
					}
					return {
						messages: [],
						parallelResults: [{ agent: "reviewer", messages: [{ role: "assistant", content: [{ type: "text", text: "review" }] }], isError: false }],
						isError: false,
					};
				},
				assert(_pi: FakePi, phase: number) {
					assert.equal(phase, 2);
				},
			},
		] as const;

		mkdirSync(join(root, "other-repo"), { recursive: true });
		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", `${testCase.name}.md`), testCase.content);

			const pi = new FakePi();
			const { ctx } = createContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);

			let phase = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				phase++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					...testCase.handle(request, phase),
				});
			});

			const [commandName, ...commandArgs] = testCase.command.split(" ");
			await pi.commands.get(commandName)!.handler(commandArgs.join(" "), ctx);
			testCase.assert(pi, phase);
		}
	});
});

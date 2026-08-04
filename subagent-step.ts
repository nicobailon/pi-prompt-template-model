import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { preparePromptExecution } from "./prompt-execution.ts";
import type { PromptWithModel } from "./prompt-loader.ts";
import { notify } from "./notifications.ts";
import {
	DEFAULT_SUBAGENT_NAME,
	appendDelegatedLiveOutput,
	clearDelegatedLiveState,
	getDelegatedLiveState,
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	updateDelegatedLiveState,
	type DelegatedSkillBinding,
	type DelegatedSubagentParallelResult,
	type DelegatedSubagentRequest,
	type DelegatedSubagentResponse,
	type DelegatedSubagentTask,
	type DelegatedSubagentTaskProgress,
	type DelegatedSubagentUpdate,
	type SubagentDelegationV1Response,
} from "./subagent-runtime.ts";
import type { SubagentOverride } from "./args.ts";
import { createDelegatedProgressWidget, DELEGATED_WIDGET_KEY } from "./subagent-widget.ts";

interface DelegatedPromptBaseOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	currentModel: Model<any> | undefined;
	override?: SubagentOverride;
	signal?: AbortSignal;
	inheritedModel?: Model<any>;
	taskPreamble?: string;
	worktree?: boolean;
	allowPartialFailures?: boolean;
	resolveSkillBindings?: (skillNames: string[], cwd: string) => DelegatedSkillBinding[];
}

interface DelegatedSinglePromptOptions extends DelegatedPromptBaseOptions {
	prompt: PromptWithModel;
	args: string[];
	parallel?: never;
}

interface DelegatedParallelTaskInput {
	prompt: PromptWithModel;
	args: string[];
	taskPrefix?: string;
}

interface DelegatedParallelPromptOptions extends DelegatedPromptBaseOptions {
	parallel: DelegatedParallelTaskInput[];
	prompt?: never;
	args?: never;
}

type DelegatedPromptOptions = DelegatedSinglePromptOptions | DelegatedParallelPromptOptions;

export interface DelegatedPromptParallelResult {
	agent: string;
	text: string;
	messages: Message[];
	isError: boolean;
	errorText?: string;
}

export interface DelegatedPromptOutcome {
	changed: boolean;
	text: string;
	agent: string;
	parallelResults?: DelegatedPromptParallelResult[];
}

function extractTextFromBlocks(content: AssistantMessage["content"]): string {
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block.type === "text") {
			const trimmed = block.text.trim();
			if (trimmed) return trimmed;
		}
	}
	return "";
}

function extractDelegatedText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = extractTextFromBlocks((message as AssistantMessage).content);
		if (text) return text;
	}
	return "";
}

function delegatedMessagesChanged(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type !== "toolCall") continue;
			if (block.name === "write" || block.name === "edit") return true;
		}
	}
	return false;
}

function coerceMessages(messages: unknown[]): Message[] {
	if (!Array.isArray(messages)) return [];
	return messages as Message[];
}

function coerceParallelResults(parallelResults: DelegatedSubagentParallelResult[] | undefined): DelegatedPromptParallelResult[] {
	if (!Array.isArray(parallelResults)) return [];
	return parallelResults.map((result) => {
		const messages = coerceMessages(result.messages);
		return {
			agent: result.agent,
			text: extractDelegatedText(messages),
			messages,
			isError: result.isError === true,
			errorText: result.errorText,
		};
	});
}

function renderParallelDelegatedText(
	results: Array<{
		agent: string;
		messages: Message[];
	}>,
): string {
	return results
		.map((result, index) => {
			const text = extractDelegatedText(result.messages);
			const body = text || "(no assistant text)";
			return `=== Parallel Task ${index + 1} (${result.agent}) ===\n${body}`;
		})
		.join("\n\n");
}

function buildAssistantTextMessage(text: string): Message[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return [{ role: "assistant", content: [{ type: "text", text: trimmed }] }] as Message[];
}

function skillNamesFromBindings(skills: DelegatedSkillBinding[] | undefined): string[] | undefined {
	if (!skills?.length) return undefined;
	return skills.map((skill) => skill.name);
}

function isVersionedV1Response(payload: Partial<SubagentDelegationV1Response>): payload is SubagentDelegationV1Response {
	return payload.version === SUBAGENT_DELEGATION_PROTOCOL_VERSION && typeof payload.status === "string";
}

function versionedResponseChanged(payload: SubagentDelegationV1Response): boolean {
	const fileMutation = payload.effects?.fileMutation;
	return fileMutation?.attempted === true || fileMutation?.status === "observed";
}

function normalizeDelegatedResponse(data: unknown, request: DelegatedSubagentRequest): DelegatedSubagentResponse | undefined {
	if (!data || typeof data !== "object") return undefined;
	const payload = data as Partial<DelegatedSubagentResponse & SubagentDelegationV1Response>;
	if (payload.requestId !== request.requestId) return undefined;
	if (isVersionedV1Response(payload)) {
		const output = typeof payload.output === "string" ? payload.output : "";
		const isError = payload.status !== "completed";
		return {
			requestId: payload.requestId,
			agent: payload.agent ?? request.agent,
			task: request.task,
			context: request.context,
			model: payload.model ?? request.model,
			cwd: request.cwd,
			messages: buildAssistantTextMessage(output),
			isError,
			errorText: payload.error ?? (isError ? payload.status : undefined),
			changed: versionedResponseChanged(payload),
		};
	}
	return payload as DelegatedSubagentResponse;
}

function resolveDelegationName(prompt: PromptWithModel, override?: SubagentOverride): string | undefined {
	if (override) {
		return override.agent || (typeof prompt.subagent === "string" ? prompt.subagent : DEFAULT_SUBAGENT_NAME);
	}
	if (prompt.subagent === true) return DEFAULT_SUBAGENT_NAME;
	if (typeof prompt.subagent === "string") return prompt.subagent;
	return undefined;
}

interface PreparedDelegatedTask {
	promptName: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	skills?: DelegatedSkillBinding[];
	cwd: string;
}

async function prepareDelegatedTask(
	task: DelegatedParallelTaskInput,
	ctx: ExtensionContext,
	currentModel: Model<any> | undefined,
	override: SubagentOverride | undefined,
	inheritedModel: Model<any> | undefined,
	taskPreamble: string | undefined,
	resolveSkillBindings: DelegatedPromptBaseOptions["resolveSkillBindings"],
): Promise<PreparedDelegatedTask> {
	const requestedAgent = resolveDelegationName(task.prompt, override);
	if (!requestedAgent) {
		throw new Error(`Prompt \`${task.prompt.name}\` is not configured for delegated execution.`);
	}
	const effectiveCwd = task.prompt.cwd ?? ctx.cwd;
	if (effectiveCwd !== ctx.cwd && !existsSync(effectiveCwd)) {
		throw new Error(`cwd directory does not exist: ${effectiveCwd}`);
	}
	const agent = requestedAgent;
	const skills = task.prompt.skill;
	const skillBindings = skills?.length
		? resolveSkillBindings?.(skills, effectiveCwd)
		: undefined;
	if (skills?.length && !resolveSkillBindings) {
		throw new Error(`Prompt \`${task.prompt.name}\` cannot resolve delegated skills.`);
	}
	const prepared = await preparePromptExecution(
		task.prompt,
		task.args,
		currentModel,
		ctx.modelRegistry,
		inheritedModel === undefined
			? { scopedModels: ctx.scopedModels }
			: { inheritedModel, scopedModels: ctx.scopedModels },
	);
	if (!prepared) {
		throw new Error(`No available model from: ${task.prompt.models.join(", ")}`);
	}
	if ("message" in prepared) {
		if (prepared.warning) notify(ctx, prepared.warning, "warning");
		throw new Error(prepared.message);
	}
	if (prepared.warning) notify(ctx, prepared.warning, "warning");
	let taskText = prepared.content;
	if (!task.prompt.inheritContext && taskPreamble) {
		taskText = `${taskPreamble}\n\n---\n\n${prepared.content}`;
	}
	if (task.taskPrefix) {
		taskText = `${task.taskPrefix}\n\n${taskText}`;
	}

	return {
		promptName: task.prompt.name,
		agent,
		task: taskText,
		context: task.prompt.inheritContext ? "fork" : "fresh",
		model: `${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`,
		skills: skillBindings,
		cwd: effectiveCwd,
	};
}

function formatProgressStatus(update: DelegatedSubagentUpdate): string | undefined {
	if (update.currentTool) {
		return `running ${update.currentTool}${update.currentToolArgs ? ` ${update.currentToolArgs}` : ""}`;
	}
	if (update.taskProgress?.some((task) => task.status === "running")) {
		return "running";
	}
	if (update.toolCount && update.toolCount > 0) {
		return `completed ${update.toolCount} tool${update.toolCount === 1 ? "" : "s"}`;
	}
	return undefined;
}

function formatParallelProgressStatus(update: DelegatedSubagentUpdate): string | undefined {
	if (!update.taskProgress || update.taskProgress.length === 0) return undefined;
	const completed = update.taskProgress.filter((task) => task.status === "completed").length;
	return `parallel ${completed}/${update.taskProgress.length} running`;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function sanitizeOutputLines(lines: string[] | undefined): string[] {
	if (!lines || lines.length === 0) return [];
	return lines.filter((line): line is string => typeof line === "string" && line.trim() && line.trim() !== "(running...)");
}

function collectNewOutputLines(previous: string[] | undefined, next: string[] | undefined): string[] {
	const previousLines = sanitizeOutputLines(previous);
	const nextLines = sanitizeOutputLines(next);
	if (nextLines.length === 0) return [];
	if (previousLines.length === 0) return nextLines;

	const overlapLimit = Math.min(previousLines.length, nextLines.length);
	for (let overlap = overlapLimit; overlap > 0; overlap--) {
		let matches = true;
		for (let index = 0; index < overlap; index++) {
			if (previousLines[previousLines.length - overlap + index] !== nextLines[index]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return nextLines.slice(overlap);
		}
	}

	return nextLines;
}

function mergeTaskProgress(
	requestTasks: DelegatedSubagentTask[] | undefined,
	existingProgress: DelegatedSubagentTaskProgress[] | undefined,
	incomingProgress: DelegatedSubagentTaskProgress[] | undefined,
): DelegatedSubagentTaskProgress[] | undefined {
	if (!requestTasks || requestTasks.length === 0) return incomingProgress;

	const merged = requestTasks.map((task, index) => {
		const existing =
			existingProgress?.find((entry) => entry.index === index) ??
			existingProgress?.[index] ??
			existingProgress?.find((entry) => entry.agent === task.agent);
		return {
			index,
			agent: task.agent,
			status: existing?.status ?? "pending",
			currentTool: existing?.currentTool,
			currentToolArgs: existing?.currentToolArgs,
			recentOutput: existing?.recentOutput,
			recentOutputLines: existing?.recentOutputLines,
			recentTools: existing?.recentTools,
			model: existing?.model ?? task.model,
			toolCount: existing?.toolCount,
			durationMs: existing?.durationMs,
			tokens: existing?.tokens,
		};
	});

	if (!incomingProgress || incomingProgress.length === 0) return merged;

	const consumed = new Set<number>();
	for (const entry of incomingProgress) {
		let targetIndex =
			typeof entry.index === "number" && entry.index >= 0 && entry.index < merged.length
				? entry.index
				: -1;

		if (targetIndex < 0) {
			targetIndex = merged.findIndex((task, index) => task.agent === entry.agent && !consumed.has(index));
		}
		if (targetIndex < 0) continue;
		consumed.add(targetIndex);
		const current = merged[targetIndex]!;
		merged[targetIndex] = {
			index: targetIndex,
			agent: current.agent,
			status: entry.status ?? current.status,
			currentTool: hasOwn(entry, "currentTool") ? entry.currentTool : current.currentTool,
			currentToolArgs: hasOwn(entry, "currentToolArgs") ? entry.currentToolArgs : current.currentToolArgs,
			recentOutput: entry.recentOutput ?? current.recentOutput,
			recentOutputLines: entry.recentOutputLines ?? current.recentOutputLines,
			recentTools: entry.recentTools ?? current.recentTools,
			model: entry.model ?? current.model,
			toolCount: entry.toolCount ?? current.toolCount,
			durationMs: entry.durationMs ?? current.durationMs,
			tokens: entry.tokens ?? current.tokens,
		};
	}

	return merged;
}

async function requestDelegatedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: DelegatedSubagentRequest,
	signal?: AbortSignal,
): Promise<DelegatedSubagentResponse> {
	return await new Promise((resolve, reject) => {
		const requestLabel = request.tasks && request.tasks.length > 0 ? `parallel(${request.tasks.length})` : request.agent;
		let done = false;
		let started = false;
		const startTimeoutMs = Number(process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS ?? "15000");
		const effectiveTimeout = Number.isFinite(startTimeoutMs) && startTimeoutMs > 0 ? startTimeoutMs : 15_000;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error(`Delegated subagent \`${requestLabel}\` did not start within ${Math.round(effectiveTimeout / 1000)}s. Check that the pi-subagents extension is loaded.`)));
		}, effectiveTimeout);

		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const requestId = (data as { requestId?: unknown }).requestId;
			if (requestId !== request.requestId) return;
			started = true;
			clearTimeout(startTimeout);
			updateDelegatedLiveState(request.requestId, {
				status: "running...",
				toolCount: 0,
				recentOutput: [],
				taskProgress: request.tasks?.map((task, index) => ({ index, agent: task.agent, status: "pending" })) ?? [],
			});
			showWidget();
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const payload = normalizeDelegatedResponse(data, request);
			if (!payload) return;
			clearTimeout(startTimeout);
			updateDelegatedLiveState(request.requestId, {
				status: payload.isError ? "failed" : "completed",
				taskProgress: payload.parallelResults?.map((result, index) => ({
					index,
					agent: result.agent,
					status: result.isError ? "failed" : "completed",
				})),
			});
			clearWidget();
			finish(() => resolve(payload));
		};

		let lastProgressStatus = "";
		let widgetSet = false;
		let refreshTimer: ReturnType<typeof setInterval> | null = null;

		const showWidget = () => {
			if (!ctx.hasUI || widgetSet) return;
			widgetSet = true;
			ctx.ui.setWidget(
				DELEGATED_WIDGET_KEY,
				(_tui, theme) => createDelegatedProgressWidget(request.requestId, request.agent, request.context, request.task, request.tasks, theme, request.model),
				{ placement: "aboveEditor" },
			);
			// Force TUI repaints every second so the elapsed timer ticks during idle periods
			refreshTimer = setInterval(() => {
				if (done) return;
				const statusLine = lastProgressStatus || "running...";
				ctx.ui.setStatus("prompt-subagent", `delegating to ${requestLabel} · ${statusLine}`);
			}, 1000);
		};

		const clearWidget = () => {
			if (refreshTimer) {
				clearInterval(refreshTimer);
				refreshTimer = null;
			}
			if (ctx.hasUI && widgetSet) {
				ctx.ui.setWidget(DELEGATED_WIDGET_KEY, undefined);
				widgetSet = false;
			}
		};

		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as DelegatedSubagentUpdate;
			if (update.requestId !== request.requestId) return;

			const previousTaskProgress = getDelegatedLiveState(request.requestId)?.taskProgress;
			const mergedTaskProgress = mergeTaskProgress(
				request.tasks,
				previousTaskProgress,
				update.taskProgress,
			);
			const isParallel = (request.tasks?.length ?? 0) > 0;
			const progressStatus = isParallel
				? formatParallelProgressStatus({
					...update,
					taskProgress: mergedTaskProgress,
				}) ?? formatProgressStatus(update)
				: formatProgressStatus(update);
			if (progressStatus) {
				lastProgressStatus = progressStatus;
			}

			updateDelegatedLiveState(request.requestId, {
				status: progressStatus ?? (lastProgressStatus || "running..."),
				currentTool: update.currentTool,
				currentToolArgs: update.currentToolArgs,
				recentTools: update.recentTools,
				model: update.model,
				toolCount: update.toolCount,
				durationMs: update.durationMs,
				tokens: update.tokens,
				taskProgress: mergedTaskProgress,
			});

			if (!isParallel) {
				if (update.recentOutputLines && update.recentOutputLines.length > 0) {
					updateDelegatedLiveState(request.requestId, {
						recentOutput: sanitizeOutputLines(update.recentOutputLines),
					});
				} else {
					appendDelegatedLiveOutput(request.requestId, update.recentOutput);
				}
			}

			if (isParallel && mergedTaskProgress) {
				for (const task of mergedTaskProgress) {
					const previousTask =
						previousTaskProgress?.find((entry) => entry.index === task.index) ??
						previousTaskProgress?.find((entry) => entry.agent === task.agent);

					const newOutputLines = collectNewOutputLines(previousTask?.recentOutputLines, task.recentOutputLines);
					if (newOutputLines.length > 0) {
						for (const line of newOutputLines) {
							appendDelegatedLiveOutput(request.requestId, line);
						}
						continue;
					}

					if (!task.recentOutput || task.recentOutput === previousTask?.recentOutput) {
						continue;
					}
					appendDelegatedLiveOutput(request.requestId, task.recentOutput);
				}
			}
			if (!ctx.hasUI) return;
			const statusLine = progressStatus ?? (lastProgressStatus || "running...");
			ctx.ui.setStatus("prompt-subagent", `delegating to ${requestLabel} · ${statusLine}`);
		};

		const onTerminalInput = ctx.mode === "tui"
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, {
					requestId: request.requestId,
					reason: "escape",
				});
				finish(() => reject(new Error("Delegated prompt cancelled.")));
				return { consume: true };
			})
			: undefined;

		const unsubscribeStarted = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, onStarted);
		const unsubscribeResponse = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, onResponse);
		const unsubscribeUpdate = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, onUpdate);
		let onAbort: (() => void) | undefined;

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubscribeStarted();
			unsubscribeResponse();
			unsubscribeUpdate();
			onTerminalInput?.();
			clearWidget();
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			next();
		};

		onAbort = () => {
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, {
				requestId: request.requestId,
				reason: "abort",
			});
			finish(() => reject(new Error("Delegated prompt cancelled.")));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);

		// The bridge emits STARTED_EVENT synchronously during the REQUEST_EVENT
		// emit (all sync before the first await in the async handler chain).
		// If started is still false, no bridge received the request.
		if (!started && done) return; // already finished (e.g. response came synchronously)
		if (!started) {
			finish(() => reject(new Error(
				`No loaded pi-subagents bridge responded for \`${requestLabel}\`. ` +
				`Install or load pi-subagents and make sure no extension name conflicts are blocking it.`,
			)));
			return;
		}
	});
}

export async function executeSubagentPromptStep(options: DelegatedPromptOptions): Promise<DelegatedPromptOutcome | undefined> {
	const { pi, ctx, currentModel, override, signal, inheritedModel, taskPreamble, allowPartialFailures, resolveSkillBindings } = options;
	const isParallelRequest = "parallel" in options;

	const tasks = isParallelRequest
		? options.parallel
		: [{ prompt: options.prompt, args: options.args }];
	if (tasks.length === 0) return undefined;

	const preparedTasks: PreparedDelegatedTask[] = [];
	for (const task of tasks) {
		const preparedTask = await prepareDelegatedTask(task, ctx, currentModel, override, inheritedModel, taskPreamble, resolveSkillBindings);
		preparedTasks.push(preparedTask);
	}

	const requestContext = preparedTasks[0]!.context;
	const requestCwd = preparedTasks[0]!.cwd;
	for (const preparedTask of preparedTasks) {
		if (preparedTask.context !== requestContext) {
			throw new Error("Parallel delegated prompts must share the same inheritContext setting.");
		}
		if (options.worktree === true && preparedTask.cwd !== requestCwd) {
			throw new Error("Parallel delegated prompts with worktree enabled must share the same cwd setting.");
		}
	}

	const requestSkill = isParallelRequest ? undefined : skillNamesFromBindings(preparedTasks[0]!.skills);
	const request: DelegatedSubagentRequest = {
		...(requestSkill ? { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, skill: requestSkill } : {}),
		requestId: randomUUID(),
		agent: preparedTasks[0]!.agent,
		task: preparedTasks[0]!.task,
		...(isParallelRequest
			? {
				tasks: preparedTasks.map<DelegatedSubagentTask>((task) => {
					const skill = skillNamesFromBindings(task.skills);
					return {
						agent: task.agent,
						task: task.task,
						model: task.model,
						...(skill ? { skill } : {}),
						cwd: task.cwd,
					};
				}),
			}
			: {}),
		context: requestContext,
		model: preparedTasks[0]!.model,
		cwd: requestCwd,
		...(options.worktree ? { worktree: true } : {}),
	};

	const promptLabel = preparedTasks.map((task) => task.promptName).join(", ");
	const skillNames = [...new Set(preparedTasks.flatMap((task) => task.skills?.map((skill) => skill.name) ?? []))];
	const skillLabel = skillNames.length > 0 ? ` with skills ${skillNames.map((name) => `\`${name}\``).join(", ")}` : "";
	const statusLabel = isParallelRequest ? `parallel(${preparedTasks.length})` : preparedTasks[0]!.agent;
	if (ctx.hasUI) {
		ctx.ui.setStatus("prompt-subagent", `delegating to ${statusLabel}`);
		ctx.ui.setWorkingMessage(isParallelRequest ? `Running delegated parallel prompts with ${statusLabel}...` : `Running delegated prompt with ${statusLabel}...`);
	}
	notify(
		ctx,
		isParallelRequest
			? `Delegating parallel prompts (${promptLabel})${skillLabel}`
			: `Delegating prompt \`${preparedTasks[0]!.promptName}\` to subagent \`${preparedTasks[0]!.agent}\`${skillLabel}`,
		"info",
	);

	try {
		const response = await requestDelegatedRun(pi, ctx, request, signal);
		if (response.isError) {
			throw new Error(
				`Delegated prompt execution failed: ${response.errorText || "unknown delegated error"}`,
			);
		}

		if (isParallelRequest) {
			const parallelResults = coerceParallelResults(response.parallelResults);
			if (parallelResults.length === 0) {
				throw new Error("Delegated parallel execution returned no results.");
			}
			const failures = parallelResults.filter((result) => result.isError);
			if (!allowPartialFailures && failures.length > 0) {
				const failureText = failures
					.map((failure) => `${failure.agent}: ${failure.errorText || "unknown delegated error"}`)
					.join("; ");
				throw new Error(`Delegated parallel execution failed: ${failureText}`);
			}

			const text = response.contentText?.trim() || renderParallelDelegatedText(parallelResults);
			const changed =
				parallelResults.some((result) => delegatedMessagesChanged(result.messages))
				|| text.includes("=== Worktree Changes ===");
			pi.sendMessage({
				customType: PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
				content: text,
				display: true,
				details: {
					requestId: response.requestId,
					agent: request.agent,
					task: preparedTasks.map((task) => task.task).join("\n\n"),
					context: response.context,
					model: response.model,
					messages: [],
					parallelResults,
					text,
					changed,
					isError: false,
					errorText: response.errorText,
				},
			});

			return {
				changed,
				text,
				agent: request.agent,
				parallelResults,
			};
		}

		const messages = coerceMessages(response.messages);
		const text = extractDelegatedText(messages);
		if (!text) {
			throw new Error("Delegated subagent returned no assistant text.");
		}

		const changed = response.changed ?? delegatedMessagesChanged(messages);
		pi.sendMessage({
			customType: PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
			content: text,
			display: true,
			details: {
				requestId: response.requestId,
				agent: preparedTasks[0]!.agent,
				task: request.task,
				context: response.context,
				model: response.model,
				messages,
				text,
				changed,
				isError: false,
				errorText: response.errorText,
			},
		});

		return {
			changed,
			text,
			agent: preparedTasks[0]!.agent,
		};
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		const responseText = cause.message;
		if (isParallelRequest) {
			throw new Error(`Parallel delegated prompts (${promptLabel}) failed: ${responseText}`, { cause });
		}
		throw new Error(`Prompt \`${preparedTasks[0]!.promptName}\` delegated subagent \`${preparedTasks[0]!.agent}\` failed: ${responseText}`, { cause });
	} finally {
		clearDelegatedLiveState(request.requestId);
		if (ctx.hasUI) {
			ctx.ui.setStatus("prompt-subagent", undefined);
			ctx.ui.setWorkingMessage();
		}
	}
}

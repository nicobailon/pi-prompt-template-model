import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	getDelegatedLiveState,
	type DelegatedSubagentLiveState,
	type DelegatedSubagentTask,
	type DelegatedSubagentTaskProgress,
} from "./subagent-runtime.ts";

export const DELEGATED_WIDGET_KEY = "prompt-subagent-progress";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m${remaining}s`;
}

function formatTokens(n: number | undefined): string {
	if (!n) return "0";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function normalizeModelLabel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	return model.includes("/") ? model.split("/").pop() : model;
}

function formatToolCall(tool: string, args: string): string {
	const safeArgs = args ?? "";
	switch (tool) {
		case "bash": {
			const cmd = safeArgs.replace(/[\n\t]/g, " ").trim();
			return `$ ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
		}
		case "read": return `[read: ${safeArgs}]`;
		case "write": return `[write: ${safeArgs}]`;
		case "edit": return `[edit: ${safeArgs}]`;
		default: {
			const short = safeArgs.length > 60 ? safeArgs.slice(0, 60) + "..." : safeArgs;
			return `[${tool}: ${short}]`;
		}
	}
}

function stateKey(state: DelegatedSubagentLiveState | undefined, elapsed: number): string {
	if (!state) return "none";
	const elapsedBucket = Math.floor(elapsed / 1000);
	const tool = state.currentTool ?? "";
	const outputLen = state.recentOutput.length;
	const outputTail = state.recentOutput.length > 0
		? state.recentOutput[state.recentOutput.length - 1]?.slice(0, 80) ?? ""
		: "";
	const toolsLen = state.recentTools.length;
	const taskProgressKey = state.taskProgress
		.map((entry) => {
			const recentOutputLines = (entry.recentOutputLines ?? []).slice(-3).join("\u241f");
			const recentTool = entry.recentTools?.[entry.recentTools.length - 1];
			return [
				entry.index ?? "",
				entry.agent,
				entry.status ?? "",
				entry.currentTool ?? "",
				entry.toolCount ?? 0,
				entry.tokens ?? 0,
				entry.model ?? "",
				recentTool?.tool ?? "",
				recentTool?.args ?? "",
				recentOutputLines,
			].join(":");
		})
		.join("|");
	return `${state.status}|${tool}|${state.toolCount}|${state.tokens}|${outputLen}:${outputTail}|${toolsLen}|${state.model ?? ""}|${taskProgressKey}|${elapsedBucket}`;
}

function getParallelPreviewLimits(taskCount: number): { tools: number; output: number } {
	if (taskCount <= 2) return { tools: 3, output: 6 };
	if (taskCount <= 4) return { tools: 2, output: 4 };
	return { tools: 2, output: 3 };
}

function resolveTaskProgress(
	taskProgress: DelegatedSubagentTaskProgress[],
	task: DelegatedSubagentTask,
	index: number,
): DelegatedSubagentTaskProgress | undefined {
	return taskProgress.find((entry) => entry.index === index)
		?? taskProgress.find((entry) => entry.index === undefined && entry.agent === task.agent)
		?? taskProgress[index];
}

function getTaskOutputLines(progress: DelegatedSubagentTaskProgress | undefined): string[] {
	if (!progress) return [];
	if (progress.recentOutputLines && progress.recentOutputLines.length > 0) {
		return progress.recentOutputLines.filter((line) => line.trim());
	}
	if (!progress.recentOutput?.trim()) return [];
	return progress.recentOutput.split("\n").filter((line) => line.trim());
}

function getTaskHeader(
	index: number,
	task: DelegatedSubagentTask,
	progress: DelegatedSubagentTaskProgress | undefined,
	theme: Theme,
): string {
	const status = progress?.status ?? "pending";
	const modelLabel = normalizeModelLabel(progress?.model ?? task.model);
	const modelSuffix = modelLabel ? ` ${theme.fg("dim", modelLabel)}` : "";
	const label = `task ${index + 1} · ${task.agent}`;
	if (status === "running") return `${theme.fg("toolTitle", label)}${modelSuffix} ${theme.fg("warning", "running")}`;
	if (status === "completed") return `${theme.fg("toolTitle", label)}${modelSuffix} ${theme.fg("success", "completed")}`;
	if (status === "failed") return `${theme.fg("toolTitle", label)}${modelSuffix} ${theme.fg("error", "failed")}`;
	return `${theme.fg("toolTitle", label)}${modelSuffix} ${theme.fg("dim", status)}`;
}

function addParallelTaskPreview(
	box: Box,
	task: DelegatedSubagentTask,
	progress: DelegatedSubagentTaskProgress | undefined,
	index: number,
	taskCount: number,
	theme: Theme,
): void {
	box.addChild(new Text(getTaskHeader(index, task, progress, theme), 0, 0));

	const limits = getParallelPreviewLimits(taskCount);
	if (!progress) {
		box.addChild(new Text(theme.fg("dim", "    waiting for updates"), 0, 0));
		return;
	}

	if (progress.currentTool) {
		box.addChild(new Text(theme.fg("warning", `    > ${formatToolCall(progress.currentTool, progress.currentToolArgs ?? "")}`), 0, 0));
	}

	const recentTools = (progress.recentTools ?? []).slice(-limits.tools);
	for (const tool of recentTools) {
		box.addChild(new Text(theme.fg("dim", `    ${formatToolCall(tool.tool, tool.args)}`), 0, 0));
	}

	const outputLines = getTaskOutputLines(progress);
	const visibleOutputLines = outputLines.slice(-limits.output);
	for (const line of visibleOutputLines) {
		box.addChild(new Text(theme.fg("dim", `    ${line}`), 0, 0));
	}

	const hiddenLineCount = outputLines.length - visibleOutputLines.length;
	if (hiddenLineCount > 0) {
		box.addChild(new Text(theme.fg("warning", `    ... (${hiddenLineCount} older line${hiddenLineCount === 1 ? "" : "s"})`), 0, 0));
	}

	if (!progress.currentTool && recentTools.length === 0 && visibleOutputLines.length === 0) {
		if (progress.status === "completed") {
			const toolCount = progress.toolCount ?? 0;
			box.addChild(new Text(theme.fg("dim", `    completed (${toolCount} tool${toolCount === 1 ? "" : "s"})`), 0, 0));
		} else if (progress.status === "failed") {
			box.addChild(new Text(theme.fg("error", "    task failed"), 0, 0));
		} else {
			box.addChild(new Text(theme.fg("dim", "    waiting for output"), 0, 0));
		}
	}
}

function rebuildBox(
	box: Box,
	agent: string,
	contextSuffix: string,
	taskPreview: string,
	parallelTasks: DelegatedSubagentTask[],
	isParallel: boolean,
	state: DelegatedSubagentLiveState | undefined,
	elapsed: number,
	theme: Theme,
	requestModel?: string,
): void {
	box.clear();

	const taskProgress = state?.taskProgress ?? [];
	const baseToolCount = state?.toolCount ?? 0;
	const baseTokens = state?.tokens ?? 0;
	const parallelToolCount = taskProgress.reduce((sum, entry) => sum + (entry.toolCount ?? 0), 0);
	const parallelTokens = taskProgress.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
	const toolCount = isParallel && parallelToolCount > 0 ? parallelToolCount : baseToolCount;
	const tokens = isParallel && parallelTokens > 0 ? parallelTokens : baseTokens;
	const tokensLabel = formatTokens(tokens);
	const duration = formatDuration(elapsed);
	const isThinking = toolCount === 0 && tokens === 0;
	const icon = theme.fg("warning", "...");
	const modelLabel = isParallel
		? requestModel
		: normalizeModelLabel(state?.model ?? requestModel);
	const modelSuffix = modelLabel ? ` ${theme.fg("dim", modelLabel)}` : "";
	const stats = isThinking
		? `thinking, ${duration}`
		: `${toolCount} tool${toolCount === 1 ? "" : "s"}, ${tokensLabel} tok, ${duration}`;

	if (isParallel) {
		const completedCount = taskProgress.filter((entry) => entry.status === "completed").length;
		const runningLabel = `parallel ${completedCount}/${parallelTasks.length} running`;
		box.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(runningLabel))}${contextSuffix}${modelSuffix} | ${stats}`, 0, 0));
	} else {
		box.addChild(new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold(agent))}${contextSuffix}${modelSuffix} | ${stats}`,
			0,
			0,
		));
	}
	box.addChild(new Spacer(1));

	if (!isParallel) {
		box.addChild(new Text(theme.fg("dim", `Task: ${taskPreview}`), 0, 0));
		box.addChild(new Spacer(1));
	}

	if (isParallel) {
		for (let index = 0; index < parallelTasks.length; index++) {
			const task = parallelTasks[index]!;
			const progress = resolveTaskProgress(taskProgress, task, index);
			addParallelTaskPreview(box, task, progress, index, parallelTasks.length, theme);
			if (index < parallelTasks.length - 1) {
				box.addChild(new Spacer(1));
			}
		}
		return;
	}

	const recentTools = state?.recentTools ?? [];
	for (const tool of recentTools) {
		box.addChild(new Text(theme.fg("dim", formatToolCall(tool.tool, tool.args)), 0, 0));
	}
	if (state?.currentTool) {
		const active = formatToolCall(state.currentTool, state.currentToolArgs ?? "");
		box.addChild(new Text(theme.fg("warning", `> ${active}`), 0, 0));
	}

	if (state && state.recentOutput.length > 0) {
		if (recentTools.length > 0 || state.currentTool) {
			box.addChild(new Spacer(1));
		}
		for (const line of state.recentOutput) {
			box.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
		}
	}
}

export function createDelegatedProgressWidget(
	requestId: string,
	agent: string,
	context: "fresh" | "fork",
	task: string,
	tasks: DelegatedSubagentTask[] | undefined,
	theme: Theme,
	model?: string,
): Container & { dispose?(): void } {
	const contextSuffix = context === "fork" ? theme.fg("warning", " [fork]") : "";
	const taskPreview = task.length > 200 ? `${task.slice(0, 200)}...` : task;
	const parallelTasks = tasks ?? [];
	const isParallel = parallelTasks.length > 0;
	const parallelModels = [...new Set(parallelTasks
		.map((task) => normalizeModelLabel(task.model))
		.filter((entry): entry is string => !!entry))];
	const requestModel = isParallel
		? (parallelModels.length === 1 ? parallelModels[0] : undefined)
		: normalizeModelLabel(model);

	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	container.addChild(box);

	let lastKey = "";

	container.render = (width: number): string[] => {
		const state = getDelegatedLiveState(requestId);
		const elapsed = state ? Date.now() - state.startedAt : 0;
		const key = stateKey(state, elapsed);
		if (key !== lastKey) {
			lastKey = key;
			rebuildBox(box, agent, contextSuffix, taskPreview, parallelTasks, isParallel, state, elapsed, theme, requestModel);
		}
		return Container.prototype.render.call(container, width);
	};

	return container;
}

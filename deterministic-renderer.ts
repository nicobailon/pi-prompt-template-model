import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { formatDeterministicExecution, type DeterministicExecutionResult } from "./deterministic-step.ts";

interface DeterministicMessage {
	content?: unknown;
	details?: DeterministicExecutionResult;
}

interface DeterministicCompletionMessage {
	content?: unknown;
	details?: {
		promptName: string;
		exitCode: number;
		timedOut: boolean;
		status: "succeeded" | "failed";
	};
}

const PREVIEW_LINES = 8;

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${durationMs}ms`;
	if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
	return `${Math.round(durationMs / 1_000)}s`;
}

function buildCapturedOutputLabel(
	label: string,
	meta: { totalChars: number; totalLines: number; truncated: boolean },
): string {
	if (meta.totalChars === 0) return `${label} · empty`;
	const lineCount = meta.totalLines;
	const charCount = meta.totalChars.toLocaleString();
	const truncated = meta.truncated ? " · capped" : "";
	return `${label} · ${lineCount} line${lineCount === 1 ? "" : "s"} · ${charCount} chars${truncated}`;
}

function renderOutputSection(
	box: Box,
	label: string,
	value: string,
	meta: { totalChars: number; totalLines: number; truncated: boolean },
	options: MessageRenderOptions,
	theme: Theme,
) {
	box.addChild(new Text(theme.fg("toolTitle", buildCapturedOutputLabel(label, meta)), 0, 0));
	if (!value) {
		box.addChild(new Text(theme.fg("dim", "(empty)"), 0, 0));
		return;
	}
	const lines = value.split("\n");
	if (options.expanded || lines.length <= PREVIEW_LINES) {
		box.addChild(new Text(theme.fg("toolOutput", value), 0, 0));
		if (meta.truncated) {
			box.addChild(new Text(theme.fg("warning", `\n... (stored preview capped, ${Math.max(0, meta.totalChars - value.length)} more chars hidden)`), 0, 0));
		}
		return;
	}
	box.addChild(new Text(theme.fg("toolOutput", lines.slice(0, PREVIEW_LINES).join("\n")), 0, 0));
	box.addChild(new Text(theme.fg("warning", `\n... (${lines.length - PREVIEW_LINES} more lines hidden — Ctrl+O to expand)`), 0, 0));
	if (meta.truncated) {
		box.addChild(new Text(theme.fg("warning", `\n... (stored preview capped, ${Math.max(0, meta.totalChars - value.length)} more chars hidden)`), 0, 0));
	}
}

export function renderDeterministicResult(message: DeterministicMessage, options: MessageRenderOptions, theme: Theme) {
	const details = message.details;
	const container = new Container();
	container.addChild(new Spacer(1));
	if (!details) {
		container.addChild(new Text(theme.fg("warning", "Deterministic step message is missing details."), 0, 0));
		return container;
	}

	const failed = details.exitCode !== 0;
	const box = new Box(1, 1, (text: string) => theme.bg(failed ? "toolPendingBg" : "toolSuccessBg", text));
	const icon = theme.fg(failed ? "error" : "success", failed ? "fail" : "ok");
	const status = failed ? "failed" : "succeeded";
	const title = formatDeterministicExecution(details.execution, details.resolvedScriptPath);
	box.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("deterministic"))} | ${status} · exit ${details.exitCode} · ${formatDuration(details.durationMs)}`, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("dim", `command: ${title}`), 0, 0));
	if (details.resolvedScriptPath) {
		box.addChild(new Text(theme.fg("dim", `script: ${details.resolvedScriptPath}`), 0, 0));
	}
	box.addChild(new Text(theme.fg("dim", `cwd: ${details.cwd}`), 0, 0));
	if (details.signal) {
		box.addChild(new Text(theme.fg("dim", `signal: ${details.signal}`), 0, 0));
	}
	if (details.timedOut) {
		box.addChild(new Text(theme.fg("error", "timeout reached before the process exited"), 0, 0));
	}
	box.addChild(new Text(theme.fg("dim", `nonInteractive: ${details.nonInteractive ? "true" : "false"}`), 0, 0));
	box.addChild(new Spacer(1));
	renderOutputSection(box, "stdout", details.stdout, {
		totalChars: details.stdoutTotalChars,
		totalLines: details.stdoutTotalLines,
		truncated: details.stdoutTruncated,
	}, options, theme);
	box.addChild(new Spacer(1));
	renderOutputSection(box, "stderr", details.stderr, {
		totalChars: details.stderrTotalChars,
		totalLines: details.stderrTotalLines,
		truncated: details.stderrTruncated,
	}, options, theme);
	container.addChild(box);
	return container;
}

export function renderDeterministicCompletion(
	message: DeterministicCompletionMessage,
	_options: MessageRenderOptions,
	theme: Theme,
) {
	const details = message.details;
	const container = new Container();
	container.addChild(new Spacer(1));
	if (!details) {
		container.addChild(new Text(theme.fg("warning", "Deterministic completion message is missing details."), 0, 0));
		return container;
	}

	const failed = details.status === "failed";
	const box = new Box(1, 1, (text: string) => theme.bg(failed ? "toolPendingBg" : "toolSuccessBg", text));
	const icon = theme.fg(failed ? "error" : "success", failed ? "fail" : "ok");
	box.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("deterministic complete"))} | ${details.status} · exit ${details.exitCode}`, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("dim", `prompt: ${details.promptName}`), 0, 0));
	box.addChild(new Text(theme.fg("dim", "model handoff: skipped"), 0, 0));
	if (details.timedOut) {
		box.addChild(new Text(theme.fg("error", "the command hit its timeout before completion"), 0, 0));
	}
	container.addChild(box);
	return container;
}

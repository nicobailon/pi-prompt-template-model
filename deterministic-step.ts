import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PromptWithModel, DeterministicStep, DeterministicExecution, DeterministicEnv } from "./prompt-loader.ts";

export const PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE = "prompt-template-deterministic";
export const PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE = "prompt-template-deterministic-complete";

const DEFAULT_MAX_CAPTURE_STDOUT_CHARS = 16_000;
const DEFAULT_MAX_CAPTURE_STDERR_CHARS = 16_000;
const DEFAULT_TIMEOUT_KILL_AFTER_MS = 1_000;

interface CapturedOutput {
	text: string;
	totalChars: number;
	totalNewlines: number;
	trailingNewlineRun: number;
	sawNonNewline: boolean;
	truncated: boolean;
	maxChars: number;
}

export interface DeterministicExecutionResult {
	execution: DeterministicExecution;
	cwd: string;
	nonInteractive: boolean;
	resolvedScriptPath?: string;
	exitCode: number;
	signal?: NodeJS.Signals;
	stdout: string;
	stdoutTotalChars: number;
	stdoutTotalLines: number;
	stdoutTruncated: boolean;
	stderr: string;
	stderrTotalChars: number;
	stderrTotalLines: number;
	stderrTruncated: boolean;
	durationMs: number;
	timedOut: boolean;
}

export interface DeterministicPreambleOptions {
	maxStdoutChars?: number;
	maxStderrChars?: number;
}

function createCapturedOutput(maxChars: number): CapturedOutput {
	return {
		text: "",
		totalChars: 0,
		totalNewlines: 0,
		trailingNewlineRun: 0,
		sawNonNewline: false,
		truncated: false,
		maxChars,
	};
}

function appendCapturedOutput(output: CapturedOutput, chunk: string): void {
	if (!chunk) return;
	output.totalChars += chunk.length;
	const newlines = chunk.match(/\n/g)?.length ?? 0;
	output.totalNewlines += newlines;
	if (/[^\n]/.test(chunk)) output.sawNonNewline = true;
	const trailingRun = chunk.match(/\n+$/)?.[0].length ?? 0;
	if (trailingRun === 0) {
		output.trailingNewlineRun = 0;
	} else if (trailingRun === chunk.length) {
		output.trailingNewlineRun += trailingRun;
	} else {
		output.trailingNewlineRun = trailingRun;
	}

	if (output.text.length < output.maxChars) {
		const remaining = output.maxChars - output.text.length;
		output.text += chunk.slice(0, remaining);
	}
	if (output.totalChars > output.maxChars) output.truncated = true;
}

function capturedLineCount(output: Pick<CapturedOutput, "totalChars" | "sawNonNewline" | "totalNewlines" | "trailingNewlineRun">): number {
	if (output.totalChars === 0) return 0;
	if (!output.sawNonNewline) return 1;
	return output.totalNewlines - output.trailingNewlineRun + 1;
}

function countLines(value: string): number {
	if (!value) return 0;
	const normalized = value.replace(/\n+$/g, "");
	if (!normalized) return 1;
	return normalized.split("\n").length;
}

function buildTextPreview(label: string, value: string, totalChars: number, maxChars: number): { text: string; truncated: boolean; omittedChars: number } {
	const shownChars = Math.min(value.length, maxChars);
	const preview = value.slice(0, shownChars);
	const omittedChars = Math.max(0, totalChars - shownChars);
	if (omittedChars === 0) {
		return { text: preview, truncated: false, omittedChars: 0 };
	}
	return {
		text: `${preview}\n...[${label} truncated, ${omittedChars} more chars omitted]`,
		truncated: true,
		omittedChars,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatDeterministicExecution(execution: DeterministicExecution, resolvedScriptPath?: string): string {
	switch (execution.kind) {
		case "run":
			return execution.command;
		case "command": {
			const parts = [execution.command, ...execution.args].map((part) => shellQuote(part));
			return execution.shell ? `${parts.join(" ")} (shell)` : parts.join(" ");
		}
		case "script": {
			const scriptPath = resolvedScriptPath ?? execution.path;
			const parts = [scriptPath, ...execution.args].map((part) => shellQuote(part));
			return parts.join(" ");
		}
	}
}

export function shouldHandoffToLlm(step: DeterministicStep, result: Pick<DeterministicExecutionResult, "exitCode">): boolean {
	switch (step.handoff) {
		case "always": return true;
		case "never": return false;
		case "on-success": return result.exitCode === 0;
		case "on-failure": return result.exitCode !== 0;
	}
}

function buildOutputPreambleSectionFromResult(
	label: "stdout" | "stderr",
	value: string,
	meta: { totalChars: number; totalLines: number },
	maxChars: number,
): string[] {
	const preview = buildTextPreview(label, value, meta.totalChars, maxChars);
	return [
		`[${label}]`,
		`lineCount: ${meta.totalLines}`,
		`charCount: ${meta.totalChars}`,
		`truncated: ${preview.truncated ? "true" : "false"}`,
		preview.truncated ? `omittedChars: ${preview.omittedChars}` : undefined,
		"preview:",
		preview.text || "(empty)",
	];
}

export function buildDeterministicPreamble(
	result: DeterministicExecutionResult,
	options: DeterministicPreambleOptions = {},
): string {
	const maxStdoutChars = options.maxStdoutChars ?? 8_000;
	const maxStderrChars = options.maxStderrChars ?? 4_000;
	const command = formatDeterministicExecution(result.execution, result.resolvedScriptPath);
	return [
		"[Deterministic step]",
		`status: ${result.exitCode === 0 ? "succeeded" : "failed"}`,
		`executionKind: ${result.execution.kind}`,
		`command: ${command.includes("\n") ? JSON.stringify(command) : command}`,
		result.resolvedScriptPath ? `resolvedScript: ${result.resolvedScriptPath}` : undefined,
		`cwd: ${result.cwd}`,
		`nonInteractive: ${result.nonInteractive ? "true" : "false"}`,
		`exitCode: ${result.exitCode}`,
		result.signal ? `signal: ${result.signal}` : undefined,
		`durationMs: ${result.durationMs}`,
		`timedOut: ${result.timedOut ? "true" : "false"}`,
		"",
		...buildOutputPreambleSectionFromResult("stdout", result.stdout, {
			totalChars: result.stdoutTotalChars,
			totalLines: result.stdoutTotalLines,
		}, maxStdoutChars),
		"",
		...buildOutputPreambleSectionFromResult("stderr", result.stderr, {
			totalChars: result.stderrTotalChars,
			totalLines: result.stderrTotalLines,
		}, maxStderrChars),
	].filter((line): line is string => line !== undefined).join("\n");
}

function resolveScriptPath(prompt: Pick<PromptWithModel, "filePath">, cwd: string, execution: Extract<DeterministicExecution, { kind: "script" }>): string {
	if (isAbsolute(execution.path)) return execution.path;
	const promptRelative = resolve(dirname(prompt.filePath), execution.path);
	if (existsSync(promptRelative)) return promptRelative;
	return resolve(cwd, execution.path);
}

function buildDeterministicEnv(step: Pick<DeterministicStep, "env" | "nonInteractive">): NodeJS.ProcessEnv {
	const nonInteractiveDefaults: DeterministicEnv = step.nonInteractive
		? {
			CI: "1",
			GIT_TERMINAL_PROMPT: "0",
			PAGER: "cat",
			GIT_PAGER: "cat",
		}
		: {};
	return {
		...process.env,
		...nonInteractiveDefaults,
		...(step.env ?? {}),
	};
}

function spawnProcess(command: string, args: string[], options: { cwd: string; shell?: boolean; env: NodeJS.ProcessEnv }) {
	return spawn(command, args, {
		cwd: options.cwd,
		shell: options.shell ?? false,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export async function runDeterministicStep(
	prompt: Pick<PromptWithModel, "filePath">,
	step: DeterministicStep,
	cwd: string,
): Promise<DeterministicExecutionResult> {
	const startedAt = Date.now();
	const execution = step.execution;
	const resolvedCwd = step.cwd ?? cwd;
	const env = buildDeterministicEnv(step);
	const resolvedScriptPath = execution.kind === "script"
		? resolveScriptPath(prompt, resolvedCwd, execution)
		: undefined;
	const child = execution.kind === "run"
		? spawnProcess("/bin/bash", ["-lc", execution.command], { cwd: resolvedCwd, env })
		: execution.kind === "command"
			? spawnProcess(execution.command, execution.args, { cwd: resolvedCwd, shell: execution.shell, env })
			: spawnProcess(resolvedScriptPath!, execution.args, { cwd: resolvedCwd, env });

	const stdout = createCapturedOutput(DEFAULT_MAX_CAPTURE_STDOUT_CHARS);
	const stderr = createCapturedOutput(DEFAULT_MAX_CAPTURE_STDERR_CHARS);
	let timedOut = false;
	let timeoutKillHandle: NodeJS.Timeout | undefined;

	child.stdout.on("data", (chunk) => {
		appendCapturedOutput(stdout, chunk.toString());
	});
	child.stderr.on("data", (chunk) => {
		appendCapturedOutput(stderr, chunk.toString());
	});

	const timeoutHandle = step.timeoutMs
		? setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			timeoutKillHandle = setTimeout(() => {
				child.kill("SIGKILL");
			}, DEFAULT_TIMEOUT_KILL_AFTER_MS);
		}, step.timeoutMs)
		: undefined;

	return await new Promise((resolveResult) => {
		let settled = false;
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (timeoutKillHandle) clearTimeout(timeoutKillHandle);
			resolveResult({
				execution,
				cwd: resolvedCwd,
				nonInteractive: step.nonInteractive,
				resolvedScriptPath,
				exitCode: 1,
				stdout: stdout.text,
				stdoutTotalChars: stdout.totalChars,
				stdoutTotalLines: capturedLineCount(stdout),
				stdoutTruncated: stdout.truncated,
				stderr: stderr.text ? `${stderr.text}\n${error.message}` : error.message,
				stderrTotalChars: stderr.totalChars + (stderr.text ? error.message.length + 1 : error.message.length),
				stderrTotalLines: countLines(stderr.text ? `${stderr.text}\n${error.message}` : error.message),
				stderrTruncated: stderr.truncated,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
		child.on("close", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (timeoutKillHandle) clearTimeout(timeoutKillHandle);
			resolveResult({
				execution,
				cwd: resolvedCwd,
				nonInteractive: step.nonInteractive,
				resolvedScriptPath,
				exitCode: exitCode ?? (timedOut ? 124 : 1),
				signal: signal ?? undefined,
				stdout: stdout.text,
				stdoutTotalChars: stdout.totalChars,
				stdoutTotalLines: capturedLineCount(stdout),
				stdoutTruncated: stdout.truncated,
				stderr: stderr.text,
				stderrTotalChars: stderr.totalChars,
				stderrTotalLines: capturedLineCount(stderr),
				stderrTruncated: stderr.truncated,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
	});
}

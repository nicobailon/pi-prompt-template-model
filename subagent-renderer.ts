import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";

interface AssistantContent {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
}

interface SessionMessage {
	role: string;
	content?: AssistantContent[] | string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
	model?: string;
}

interface DelegatedDetails {
	requestId?: string;
	agent?: string;
	task?: string;
	context?: "fresh" | "fork";
	model?: string;
	messages?: SessionMessage[];
	parallelResults?: Array<{
		agent?: string;
		messages?: SessionMessage[];
		isError?: boolean;
		errorText?: string;
	}>;
}

const DEFAULT_AGENT = "delegate";
const PREVIEW_LINES = 8;

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as { type?: string }).type !== "text") continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string") lines.push(text);
	}
	return lines.join("\n");
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash": {
			const cmd = String(args.command ?? "").replace(/[\n\t]/g, " ").trim();
			return `$ ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
		}
		case "read": return `[read: ${args.path ?? args.file_path ?? ""}]`;
		case "write": return `[write: ${args.path ?? args.file_path ?? ""}]`;
		case "edit": return `[edit: ${args.path ?? args.file_path ?? ""}]`;
		case "grep": return `[grep: /${args.pattern ?? ""}/ in ${args.path ?? "."}]`;
		case "find": return `[find: ${args.pattern ?? ""} in ${args.path ?? "."}]`;
		case "ls": return `[ls: ${args.path ?? "."}]`;
		default: {
			const a = JSON.stringify(args).slice(0, 50);
			return `[${name}: ${a}${JSON.stringify(args).length > 50 ? "..." : ""}]`;
		}
	}
}

function extractToolCalls(messages: SessionMessage[]): string[] {
	const calls: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "toolCall" && block.name) {
				calls.push(formatToolCall(block.name, block.arguments ?? {}));
			}
		}
	}
	return calls;
}

function extractAssistantText(messages: SessionMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = extractTextContent(msg.content);
		if (text.trim()) return text;
	}
	return "";
}

function extractUsage(messages: SessionMessage[]): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; model?: string; turns: number } {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, turns = 0;
	let model: string | undefined;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		turns++;
		if (msg.usage) {
			input += msg.usage.input ?? 0;
			output += msg.usage.output ?? 0;
			cacheRead += msg.usage.cacheRead ?? 0;
			cacheWrite += msg.usage.cacheWrite ?? 0;
			cost += msg.usage.cost?.total ?? 0;
		}
		if (msg.model) model = msg.model;
	}
	return { input, output, cacheRead, cacheWrite, cost, model, turns };
}

function formatTokensShort(n: number): string {
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

export function renderDelegatedSubagentResult(
	message: { content?: unknown; details?: DelegatedDetails },
	options: MessageRenderOptions,
	theme: Theme,
) {
	const details = message.details;
	const parallelResults = details?.parallelResults ?? [];
	const hasParallelResults = parallelResults.length > 0;
	const agent = hasParallelResults ? "parallel" : (details?.agent ?? DEFAULT_AGENT);
	const context = details?.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const messages = hasParallelResults
		? parallelResults.flatMap((result) => (result.messages ?? []) as SessionMessage[])
		: ((details?.messages ?? []) as SessionMessage[]);
	const text = extractTextContent(message.content);

	const usage = extractUsage(messages);
	const toolCalls = extractToolCalls(messages);
	const toolCount = toolCalls.length;
	const tokensLabel = `${formatTokensShort(usage.output)} tok`;

	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));

	// Header: ok worker [fork] | 3 tools, 496 tok
	const icon = theme.fg("success", "ok");
	const stats = hasParallelResults
		? `${parallelResults.length} task${parallelResults.length === 1 ? "" : "s"}, ${toolCount} tool${toolCount === 1 ? "" : "s"}, ${tokensLabel}`
		: `${toolCount} tool${toolCount === 1 ? "" : "s"}, ${tokensLabel}`;
	box.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(agent))}${context} | ${stats}`, 0, 0));
	box.addChild(new Spacer(1));

	// Task preview
	if (details?.task) {
		const taskPreview = details.task.length > 120 ? `${details.task.slice(0, 120)}...` : details.task;
		box.addChild(new Text(theme.fg("dim", `Task: ${taskPreview}`), 0, 0));
		box.addChild(new Spacer(1));
	}

	if (hasParallelResults) {
		for (let index = 0; index < parallelResults.length; index++) {
			const result = parallelResults[index]!;
			const taskLabel = result.agent || `task-${index + 1}`;
			box.addChild(new Text(theme.fg("toolTitle", `=== Task ${index + 1}: ${taskLabel} ===`), 0, 0));
			const taskMessages = (result.messages ?? []) as SessionMessage[];
			const taskText = extractAssistantText(taskMessages);
			if (result.isError) {
				const errorText = result.errorText || "Task failed.";
				box.addChild(new Text(theme.fg("error", errorText), 0, 0));
				box.addChild(new Spacer(1));
				continue;
			}

			if (!taskText) {
				box.addChild(new Text(theme.fg("dim", "(no assistant text)"), 0, 0));
				box.addChild(new Spacer(1));
				continue;
			}

			const lines = taskText.split("\n");
			if (options.expanded || lines.length <= PREVIEW_LINES) {
				box.addChild(new Text(theme.fg("toolOutput", taskText), 0, 0));
			} else {
				box.addChild(new Text(theme.fg("toolOutput", lines.slice(0, PREVIEW_LINES).join("\n")), 0, 0));
				box.addChild(new Text(theme.fg("warning", `\n... (${lines.length - PREVIEW_LINES} more lines — Ctrl+O to expand)`), 0, 0));
			}
			box.addChild(new Spacer(1));
		}
	} else {
		// Tool calls
		if (toolCalls.length > 0) {
			const showCalls = options.expanded ? toolCalls : toolCalls.slice(0, 5);
			for (const call of showCalls) {
				box.addChild(new Text(theme.fg("dim", call), 0, 0));
			}
			if (!options.expanded && toolCalls.length > 5) {
				box.addChild(new Text(theme.fg("warning", `... (${toolCalls.length - 5} more tool calls)`), 0, 0));
			}
			box.addChild(new Spacer(1));
		}

		// Output text
		if (text) {
			const lines = text.split("\n");
			if (options.expanded || lines.length <= PREVIEW_LINES) {
				box.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
			} else {
				box.addChild(new Text(theme.fg("toolOutput", lines.slice(0, PREVIEW_LINES).join("\n")), 0, 0));
				box.addChild(new Text(theme.fg("warning", `\n... (${lines.length - PREVIEW_LINES} more lines — Ctrl+O to expand)`), 0, 0));
			}
			box.addChild(new Spacer(1));
		}
	}

	// Stats footer
	const statsLine = `${usage.turns} turn${usage.turns === 1 ? "" : "s"} in:${usage.input} out:${usage.output} R${formatTokensShort(usage.cacheRead)} W${formatTokensShort(usage.cacheWrite)}${usage.cost ? ` $${usage.cost.toFixed(4)}` : ""} ${usage.model ?? details?.model ?? ""}`;
	box.addChild(new Text(theme.fg("dim", statsLine), 0, 0));

	container.addChild(box);
	return container;
}

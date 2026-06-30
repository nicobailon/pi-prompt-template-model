import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE } from "./subagent-runtime.ts";

interface DelegatedMessageDetails {
	messages?: Message[];
	parallelResults?: Array<{ messages?: Message[] }>;
	text?: string;
	changed?: boolean;
}

interface CollectedSummaryData {
	filesRead: Set<string>;
	filesWritten: Set<string>;
	commandCount: number;
	lastAssistantText: string;
}

function collectAssistantActions(messages: Message[], filesRead: Set<string>, filesWritten: Set<string>): { commandCount: number; lastText: string } {
	let commandCount = 0;
	let lastText = "";

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of (msg as AssistantMessage).content) {
			if (block.type === "text") {
				lastText = block.text;
				continue;
			}
			if (block.type !== "toolCall") continue;
			if (block.name === "bash") {
				commandCount++;
				continue;
			}
			const path = (block.arguments as Record<string, unknown>).path as string | undefined;
			if (block.name === "read" && path) filesRead.add(path);
			if ((block.name === "write" || block.name === "edit") && path) filesWritten.add(path);
		}
	}

	return { commandCount, lastText };
}

function delegatedDetails(entry: SessionEntry): DelegatedMessageDetails | undefined {
	if (entry.type !== "custom_message") return undefined;
	if (entry.customType !== PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE) return undefined;
	if (!entry.details || typeof entry.details !== "object") return undefined;
	return entry.details as DelegatedMessageDetails;
}

function collectSummaryData(entries: SessionEntry[]): CollectedSummaryData {
	const filesRead = new Set<string>();
	const filesWritten = new Set<string>();
	let commandCount = 0;
	let lastAssistantText = "";

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role !== "assistant") continue;
			const collected = collectAssistantActions([msg], filesRead, filesWritten);
			commandCount += collected.commandCount;
			if (collected.lastText) lastAssistantText = collected.lastText;
			continue;
		}

		const delegated = delegatedDetails(entry);
		if (!delegated) continue;
		const messageGroups =
			delegated.parallelResults && delegated.parallelResults.length > 0
				? delegated.parallelResults.map((result) => result.messages ?? [])
				: delegated.messages ? [delegated.messages] : [];
		for (const messages of messageGroups) {
			const collected = collectAssistantActions(messages, filesRead, filesWritten);
			commandCount += collected.commandCount;
			if (collected.lastText) lastAssistantText = collected.lastText;
		}
		if (typeof delegated.text === "string" && delegated.text.trim()) {
			lastAssistantText = delegated.text;
		}
	}

	return {
		filesRead,
		filesWritten,
		commandCount,
		lastAssistantText,
	};
}

function formatSummary(header: string, entries: SessionEntry[], preserveOutcome = false): string {
	const { filesRead, filesWritten, commandCount, lastAssistantText } = collectSummaryData(entries);

	let summary = header;

	const actionParts: string[] = [];
	if (filesRead.size > 0) actionParts.push(`read ${filesRead.size} file(s)`);
	if (filesWritten.size > 0) actionParts.push(`modified ${[...filesWritten].join(", ")}`);
	if (commandCount > 0) actionParts.push(`ran ${commandCount} command(s)`);
	if (actionParts.length > 0) {
		summary += `\nActions: ${actionParts.join(", ")}.`;
	}

	if (lastAssistantText) {
		const cleaned = preserveOutcome
			? lastAssistantText.replace(/\r\n?/g, "\n").trim()
			: lastAssistantText.replace(/\n+/g, " ").trim();
		const outcome = preserveOutcome || cleaned.length <= 500 ? cleaned : `${cleaned.slice(0, 500)}...`;
		summary += `\nOutcome: ${outcome}`;
	}

	return summary;
}

export function generateIterationSummary(entries: SessionEntry[], task: string, iteration: number, totalIterations: number | null): string {
	const header = totalIterations !== null
		? `[Loop iteration ${iteration}/${totalIterations}]\nTask: "${task}"`
		: `[Loop iteration ${iteration}]\nTask: "${task}"`;
	return formatSummary(header, entries);
}

export function generateBoomerangSummary(entries: SessionEntry[], task: string): string {
	return formatSummary(`[Boomerang]\nTask: "${task}"`, entries, true);
}

export function generateChainStepSummary(entries: SessionEntry[], stepLabel: string, stepNumber: number): string {
	return formatSummary(`Step ${stepNumber} — ${stepLabel}:`, entries);
}

export function didIterationMakeChanges(entries: SessionEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type === "message") {
			if (entry.message.role !== "assistant") continue;
			for (const block of (entry.message as AssistantMessage).content) {
				if (block.type !== "toolCall") continue;
				if (block.name === "write" || block.name === "edit") return true;
			}
			continue;
		}

		const delegated = delegatedDetails(entry);
		if (!delegated) continue;
		if (delegated.changed === true) return true;
		const delegatedGroups =
			delegated.parallelResults && delegated.parallelResults.length > 0
				? delegated.parallelResults.map((result) => result.messages ?? [])
				: [delegated.messages ?? []];
		for (const messages of delegatedGroups) {
			for (const message of messages) {
				if (message.role !== "assistant") continue;
				for (const block of (message as AssistantMessage).content) {
					if (block.type !== "toolCall") continue;
					if (block.name === "write" || block.name === "edit") return true;
				}
			}
		}
	}
	return false;
}

export function getIterationEntries(ctx: Pick<ExtensionContext, "sessionManager">, startId: string | null): SessionEntry[] {
	const branch = ctx.sessionManager.getBranch();
	if (!startId) return branch;
	const startIdx = branch.findIndex((e) => e.id === startId);
	if (startIdx < 0) return branch;
	return branch.slice(startIdx + 1);
}

export function wasIterationAborted(entries: SessionEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if ((entry.message as AssistantMessage).stopReason === "aborted") return true;
	}
	return false;
}

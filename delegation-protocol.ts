import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { DelegatedSubagentContextSeed, DelegatedSubagentContextSeedMessage } from "./subagent-runtime.ts";

export const DEFAULT_CONTEXT_SEED_MAX_MESSAGES = 12;
export const DEFAULT_CONTEXT_SEED_MAX_CHARS = 24_000;
const TOOL_RESULT_MAX_CHARS = 2_000;

export function formatDelegatedModelRef(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelSpecMatchesRef(spec: string, selectedModelRef: string): boolean {
	if (spec === selectedModelRef) return true;
	const slashIndex = selectedModelRef.indexOf("/");
	if (slashIndex < 0) return false;
	const selectedProvider = selectedModelRef.slice(0, slashIndex);
	const selectedId = selectedModelRef.slice(slashIndex + 1);
	const specSlashIndex = spec.indexOf("/");
	if (specSlashIndex < 0) return spec === selectedId;
	return spec.slice(0, specSlashIndex) === selectedProvider && spec.slice(specSlashIndex + 1) === selectedId;
}

export function buildDelegatedFallbackModels(modelSpecs: string[], selectedModelRef: string): string[] | undefined {
	const fallbacks = modelSpecs.filter((spec) => !modelSpecMatchesRef(spec, selectedModelRef));
	return fallbacks.length > 0 ? fallbacks : undefined;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const marker = `\n[truncated ${text.length - maxChars} char(s)]`;
	if (maxChars <= marker.length) return { text: marker.slice(0, maxChars), truncated: true };
	const keep = Math.max(0, maxChars - marker.length);
	return { text: `${text.slice(0, keep)}${marker}`, truncated: true };
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "tool_call", "toolUse", "tool_use", "function", "functionCall", "function_call"]);
const TOOL_CALL_CONTAINER_KEYS = ["toolCall", "tool_call", "toolUse", "tool_use", "functionCall", "function_call"];
const TOOL_ARGUMENT_KEYS = new Set(["arguments", "args", "input", "command", "path", "value", "secret"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function hasToolArgumentPayload(record: Record<string, unknown>): boolean {
	for (const key of TOOL_ARGUMENT_KEYS) {
		if (Object.hasOwn(record, key)) return true;
	}
	const functionRecord = asRecord(record.function);
	return !!functionRecord && hasToolArgumentPayload(functionRecord);
}

function isToolCallBlock(record: Record<string, unknown>): boolean {
	const type = record.type;
	if (typeof type === "string" && TOOL_CALL_BLOCK_TYPES.has(type)) return true;
	for (const key of TOOL_CALL_CONTAINER_KEYS) {
		if (Object.hasOwn(record, key)) return true;
	}
	return hasToolArgumentPayload(record);
}

function getToolCallName(record: Record<string, unknown>): string {
	const functionRecord = asRecord(record.function);
	for (const key of TOOL_CALL_CONTAINER_KEYS) {
		const nestedRecord = asRecord(record[key]);
		if (nestedRecord) return getToolCallName(nestedRecord);
	}
	return typeof record.name === "string"
		? record.name
		: typeof record.toolName === "string"
			? record.toolName
			: typeof record.functionName === "string"
				? record.functionName
				: typeof functionRecord?.name === "string"
					? functionRecord.name
					: "tool";
}

function omitToolArgumentPayloads(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitToolArgumentPayloads);
	const record = asRecord(value);
	if (!record) return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		sanitized[key] = TOOL_ARGUMENT_KEYS.has(key) ? "[omitted]" : omitToolArgumentPayloads(child);
	}
	return sanitized;
}

function stringifySeedValue(value: unknown): string {
	return stringifyUnknown(omitToolArgumentPayloads(value));
}

function renderTextContent(text: string, maxChars?: number): { text: string; truncated: boolean } {
	if (maxChars === undefined) return { text, truncated: false };
	return truncateText(text, maxChars);
}

function renderContentBlocks(content: unknown, options?: { maxChars?: number }): { text: string; truncated: boolean; hasToolCall: boolean } {
	if (typeof content === "string") {
		const rendered = renderTextContent(content, options?.maxChars);
		return { ...rendered, hasToolCall: false };
	}
	const blocks = Array.isArray(content)
		? content
		: content && typeof content === "object" && (Object.hasOwn(content as Record<string, unknown>, "type") || isToolCallBlock(content as Record<string, unknown>))
			? [content]
			: undefined;
	if (!blocks) {
		const rendered = renderTextContent(stringifySeedValue(content), options?.maxChars);
		return { ...rendered, hasToolCall: false };
	}

	const parts: string[] = [];
	let truncated = false;
	let hasToolCall = false;
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		const type = record.type;
		if (type === "thinking" || type === "reasoning") continue;
		if (isToolCallBlock(record)) {
			hasToolCall = true;
			parts.push(`[tool call: ${getToolCallName(record)}]`);
			continue;
		}
		if (type === "text") {
			parts.push(typeof record.text === "string" ? record.text : stringifySeedValue(record.text));
			continue;
		}
		if (type === "toolResult" || type === "tool_result") {
			const name = typeof record.name === "string" ? record.name : typeof record.toolName === "string" ? record.toolName : "tool";
			const rendered = stringifyUnknown(record.content ?? record.result ?? record.text ?? "");
			const capped = truncateText(rendered, TOOL_RESULT_MAX_CHARS);
			truncated ||= capped.truncated;
			parts.push(`[tool result: ${name}] ${capped.text}`.trim());
			continue;
		}
		if (type === "image") continue;
		const rendered = stringifySeedValue(block);
		if (rendered && rendered !== "{}") parts.push(rendered);
	}

	const joined = parts.join("\n");
	if (options?.maxChars !== undefined) {
		const capped = truncateText(joined, options.maxChars);
		return { text: capped.text, truncated: truncated || capped.truncated, hasToolCall };
	}
	return { text: joined, truncated, hasToolCall };
}

function renderCustomContent(content: unknown): { text: string; truncated: boolean } {
	if (typeof content === "string") return { text: content, truncated: false };
	return renderContentBlocks(content);
}

interface RenderedSeedEntry extends DelegatedSubagentContextSeedMessage {
	hasTrailingToolCall?: boolean;
}

function renderSeedEntry(entry: SessionEntry): RenderedSeedEntry | undefined {
	if (entry.type === "message") {
		const message = entry.message as Message;
		const role = typeof message.role === "string" ? message.role : "custom";
		if (!["user", "assistant", "system", "toolResult"].includes(role)) return undefined;
		const rendered = renderContentBlocks(
			(message as { content?: unknown }).content,
			role === "toolResult" ? { maxChars: TOOL_RESULT_MAX_CHARS } : undefined,
		);
		const content = rendered.text.trim();
		if (!content) return undefined;
		return {
			role: role as DelegatedSubagentContextSeedMessage["role"],
			content,
			source: "message",
			id: entry.id,
			timestamp: entry.timestamp,
			truncated: rendered.truncated || undefined,
			hasTrailingToolCall: role === "assistant" && rendered.hasToolCall,
		};
	}

	if (entry.type === "custom_message") {
		const rendered = renderCustomContent(entry.content);
		const content = rendered.text.trim();
		if (!content) return undefined;
		return {
			role: "custom",
			content,
			source: entry.customType,
			id: entry.id,
			timestamp: entry.timestamp,
			truncated: rendered.truncated || undefined,
		};
	}

	if (entry.type === "branch_summary" || entry.type === "compaction") {
		const content = entry.summary.trim();
		if (!content) return undefined;
		return {
			role: "custom",
			content,
			source: entry.type,
			id: entry.id,
			timestamp: entry.timestamp,
		};
	}

	return undefined;
}

export function buildDelegatedContextSeed(
	ctx: Pick<ExtensionContext, "sessionManager">,
	options?: { maxMessages?: number; maxChars?: number },
): DelegatedSubagentContextSeed | undefined {
	const maxMessages = options?.maxMessages ?? DEFAULT_CONTEXT_SEED_MAX_MESSAGES;
	const maxChars = options?.maxChars ?? DEFAULT_CONTEXT_SEED_MAX_CHARS;
	if (maxMessages <= 0 || maxChars <= 0) return undefined;

	const branch = ctx.sessionManager.getBranch();
	const rendered = branch.map(renderSeedEntry).filter((entry): entry is RenderedSeedEntry => !!entry);
	while (rendered.length > 0 && rendered[rendered.length - 1]!.hasTrailingToolCall) {
		rendered.pop();
	}
	if (rendered.length === 0) return undefined;

	const boundedByCount = rendered.slice(-maxMessages);
	const selected: DelegatedSubagentContextSeedMessage[] = [];
	let usedChars = 0;
	let truncated = boundedByCount.length < rendered.length;
	let omittedMessages = rendered.length - boundedByCount.length;

	for (let index = boundedByCount.length - 1; index >= 0; index--) {
		const entry = boundedByCount[index]!;
		const remaining = maxChars - usedChars;
		if (remaining <= 0) {
			omittedMessages += index + 1;
			truncated = true;
			break;
		}

		let content = entry.content;
		let entryTruncated = entry.truncated === true;
		truncated ||= entryTruncated;
		if (content.length > remaining) {
			const capped = truncateText(content, remaining);
			content = capped.text;
			entryTruncated = true;
			truncated = true;
		}

		selected.unshift({
			role: entry.role,
			content,
			...(entry.source ? { source: entry.source } : {}),
			...(entry.id ? { id: entry.id } : {}),
			...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
			...(entryTruncated ? { truncated: true } : {}),
		});
		usedChars += content.length;
	}

	if (selected.length === 0) return undefined;
	return {
		kind: "bounded-session-context",
		metadata: {
			source: "active-session",
			maxToolResultChars: TOOL_RESULT_MAX_CHARS,
			excludesThinking: true,
			excludesUnresolvedTrailingToolCalls: true,
			excludesToolCallArguments: true,
		},
		messages: selected,
		includedMessages: selected.length,
		omittedMessages,
		maxMessages,
		maxChars,
		usedChars,
		truncated,
	};
}

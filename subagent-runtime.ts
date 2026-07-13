export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export const PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE = "prompt-template-subagent";
export const DEFAULT_SUBAGENT_NAME = "delegate";

export const DELEGATED_SUBAGENT_PROTOCOL_VERSION = 2;

export const DELEGATED_SUBAGENT_PROTOCOL_CAPABILITIES = [
	"effective-primary-model",
	"requested-thinking",
	"ordered-fallback-models",
	"resolved-skills",
	"bounded-context-seed",
] as const;

export interface DelegatedSubagentCompatibility {
	protocolVersion: typeof DELEGATED_SUBAGENT_PROTOCOL_VERSION;
	minProtocolVersion: 1;
	capabilities: Array<(typeof DELEGATED_SUBAGENT_PROTOCOL_CAPABILITIES)[number]>;
	optionalFields: string[];
}

export interface DelegatedSubagentSkill {
	name: string;
	content: string;
	path?: string;
}

export interface DelegatedSubagentContextSeedMessage {
	role: "user" | "assistant" | "system" | "toolResult" | "custom";
	content: string;
	source?: string;
	id?: string;
	timestamp?: string;
	truncated?: boolean;
}

export interface DelegatedSubagentContextSeedMetadata {
	source: "active-session";
	maxToolResultChars: number;
	excludesThinking: true;
	excludesUnresolvedTrailingToolCalls: true;
}

export interface DelegatedSubagentContextSeed {
	kind: "bounded-session-context";
	metadata: DelegatedSubagentContextSeedMetadata;
	messages: DelegatedSubagentContextSeedMessage[];
	includedMessages: number;
	omittedMessages: number;
	maxMessages: number;
	maxChars: number;
	usedChars: number;
	truncated: boolean;
}

export interface DelegatedSubagentTask {
	agent: string;
	task: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	skills?: DelegatedSubagentSkill[];
	cwd?: string;
}

export interface DelegatedSubagentParallelResult {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

export interface DelegatedSubagentRequest {
	requestId: string;
	protocolVersion?: number;
	compatibility?: DelegatedSubagentCompatibility;
	agent: string;
	task: string;
	tasks?: DelegatedSubagentTask[];
	context: "fresh" | "fork";
	model: string;
	fallbackModels?: string[];
	thinking?: string;
	skills?: DelegatedSubagentSkill[];
	contextSeed?: DelegatedSubagentContextSeed;
	cwd: string;
	worktree?: boolean;
}

export interface DelegatedSubagentResponse {
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	messages: unknown[];
	parallelResults?: DelegatedSubagentParallelResult[];
	contentText?: string;
	isError: boolean;
	errorText?: string;
}

export interface DelegatedSubagentUpdate {
	requestId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	taskProgress?: DelegatedSubagentTaskProgress[];
}

export interface DelegatedSubagentTaskProgress {
	index?: number;
	agent: string;
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export interface DelegatedSubagentLiveState {
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	recentTools: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount: number;
	durationMs: number;
	tokens: number;
	taskProgress: DelegatedSubagentTaskProgress[];
	startedAt: number;
	updatedAt: number;
}

const delegatedLiveState = new Map<string, DelegatedSubagentLiveState>();

export function updateDelegatedLiveState(requestId: string, update: Partial<DelegatedSubagentLiveState>): void {
	const now = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		recentTools: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		taskProgress: [],
		startedAt: now,
		updatedAt: now,
	};
	const next: DelegatedSubagentLiveState = {
		...existing,
		...update,
		recentOutput: update.recentOutput ?? existing.recentOutput,
		recentTools: update.recentTools ?? existing.recentTools,
		model: update.model ?? existing.model,
		toolCount: update.toolCount ?? existing.toolCount,
		durationMs: update.durationMs ?? (now - existing.startedAt),
		tokens: update.tokens ?? existing.tokens,
		taskProgress: update.taskProgress ?? existing.taskProgress,
		startedAt: existing.startedAt,
		updatedAt: now,
	};
	delegatedLiveState.set(requestId, next);
}

export function appendDelegatedLiveOutput(requestId: string, line?: string): void {
	if (!line || !line.trim() || line.trim() === "(running...)") return;
	const fallbackNow = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		recentTools: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		taskProgress: [],
		startedAt: fallbackNow,
		updatedAt: fallbackNow,
	};
	const recentOutput = [...existing.recentOutput, line];
	delegatedLiveState.set(requestId, {
		...existing,
		recentOutput,
		updatedAt: Date.now(),
	});
}

export function getDelegatedLiveState(requestId: string): DelegatedSubagentLiveState | undefined {
	return delegatedLiveState.get(requestId);
}

export function clearDelegatedLiveState(requestId: string): void {
	delegatedLiveState.delete(requestId);
}

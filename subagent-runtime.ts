import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export const PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE = "prompt-template-subagent";
export const DEFAULT_SUBAGENT_NAME = "delegate";

export interface DelegatedSubagentTask {
	agent: string;
	task: string;
	model?: string;
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
	agent: string;
	task: string;
	tasks?: DelegatedSubagentTask[];
	context: "fresh" | "fork";
	model: string;
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

interface RuntimeAgent {
	name: string;
}

interface DiscoverAgentsResult {
	agents: RuntimeAgent[];
}

type DiscoverAgentsFn = (cwd: string, scope: "user" | "project" | "both") => DiscoverAgentsResult;

export interface SubagentRuntime {
	root: string;
	discoverAgents: DiscoverAgentsFn;
}

let runtimeCache: SubagentRuntime | null = null;
const delegatedLiveState = new Map<string, DelegatedSubagentLiveState>();

function dedupePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of paths) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		unique.push(candidate);
	}
	return unique;
}

function packageRuntimeCandidates(moduleDir: string): string[] {
	const directParent = resolve(moduleDir, "..");
	const directCandidates = [join(directParent, "pi-subagents"), join(directParent, "subagent")];
	const maybeGitRoot = resolve(moduleDir, "..", "..", "..");
	if (basename(maybeGitRoot) !== "git") {
		return directCandidates;
	}

	const hostRoot = resolve(moduleDir, "..", "..");
	const hostCandidates: string[] = [];
	try {
		for (const entry of readdirSync(hostRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			hostCandidates.push(join(hostRoot, entry.name, "pi-subagents"));
			hostCandidates.push(join(hostRoot, entry.name, "subagent"));
		}
	} catch {
		// Ignore discovery errors here and fall back to direct candidates.
	}

	return dedupePaths([...directCandidates, ...hostCandidates]);
}

export function runtimeCandidatesFor(cwd: string, moduleDir = dirname(fileURLToPath(import.meta.url))): string[] {
	const fromEnv = process.env.PI_SUBAGENT_RUNTIME_ROOT?.trim();
	if (fromEnv) return [resolve(fromEnv)];
	return dedupePaths([
		resolve(cwd, ".pi", "agent", "extensions", "subagent"),
		join(homedir(), ".pi", "agent", "extensions", "subagent"),
		...packageRuntimeCandidates(moduleDir),
	]);
}

export function findSubagentRoot(cwd: string, moduleDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
	for (const candidate of runtimeCandidatesFor(cwd, moduleDir)) {
		if (existsSync(join(candidate, "agents.ts")) || existsSync(join(candidate, "agents.js"))) {
			return candidate;
		}
	}
	return undefined;
}

async function importRuntimeModule(root: string, baseName: string): Promise<unknown> {
	const candidates = [
		join(root, `${baseName}.ts`),
		join(root, `${baseName}.mts`),
		join(root, `${baseName}.js`),
		join(root, `${baseName}.mjs`),
	];

	let lastError: unknown;
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			return await import(pathToFileURL(filePath).href);
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError !== undefined) {
		throw lastError;
	}
	throw new Error(`Missing runtime module: ${baseName}`);
}

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

export async function ensureSubagentRuntime(cwd: string): Promise<SubagentRuntime> {
	const root = findSubagentRoot(cwd);
	if (!root) {
		throw new Error(
			"Delegated prompt execution requires the subagent extension runtime at ~/.pi/agent/extensions/subagent.",
		);
	}

	if (runtimeCache && runtimeCache.root === root) {
		return runtimeCache;
	}

	const module = await importRuntimeModule(root, "agents");
	const discoverAgents = (module as { discoverAgents?: unknown }).discoverAgents;
	if (typeof discoverAgents !== "function") {
		throw new Error(`Invalid subagent runtime at ${root}: expected discoverAgents(cwd, scope).`);
	}

	runtimeCache = {
		root,
		discoverAgents: discoverAgents as DiscoverAgentsFn,
	};
	return runtimeCache;
}

export function resolveDelegatedAgent(runtime: SubagentRuntime, cwd: string, requested: string): string {
	const discovered = runtime.discoverAgents(cwd, "both");
	if (!discovered.agents.some((agent) => agent.name === requested)) {
		throw new Error(
			`Delegated subagent \`${requested}\` not found. Available agents: ${discovered.agents.map((a) => a.name).join(", ") || "none"}.`,
		);
	}
	return requested;
}

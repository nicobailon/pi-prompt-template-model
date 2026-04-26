import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const RUNTIME_MODULE_FILENAMES = ["agents.ts", "agents.mts", "agents.js", "agents.mjs"] as const;

function hasRuntimeModule(candidate: string): boolean {
	return RUNTIME_MODULE_FILENAMES.some((fileName) => existsSync(join(candidate, fileName)));
}

function getGlobalNpmRoot(): string | undefined {
	try {
		const output = execFileSync("npm", ["root", "-g"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output ? resolve(output) : undefined;
	} catch {
		return undefined;
	}
}

function findGitPackageCandidates(root: string): string[] {
	if (!existsSync(root)) return [];

	const runtimeRoots: string[] = [];
	const directoriesToVisit = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name));

	while (directoriesToVisit.length > 0) {
		const currentDir = directoriesToVisit.pop();
		if (!currentDir) continue;
		if (hasRuntimeModule(currentDir)) runtimeRoots.push(currentDir);
		for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			directoriesToVisit.push(join(currentDir, entry.name));
		}
	}

	return runtimeRoots;
}

function runtimeCandidates(cwd: string): string[] {
	const configuredRoot = process.env.PI_SUBAGENT_RUNTIME_ROOT?.trim();
	if (configuredRoot) return [resolve(configuredRoot)];

	const home = homedir();
	const localSibling = resolve(dirname(fileURLToPath(import.meta.url)), "..", "subagent");
	const globalNpmRoot = getGlobalNpmRoot();
	const candidates = [
		resolve(cwd, ".pi", "extensions", "subagent"),
		resolve(cwd, ".pi", "npm", "node_modules", "pi-subagents"),
		...findGitPackageCandidates(resolve(cwd, ".pi", "git")),
		join(home, ".pi", "agent", "extensions", "subagent"),
		...findGitPackageCandidates(join(home, ".pi", "agent", "git")),
		globalNpmRoot ? join(globalNpmRoot, "pi-subagents") : undefined,
		localSibling,
	];

	const resolvedCandidates = candidates
		.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
		.map((candidate) => resolve(candidate));
	return [...new Set(resolvedCandidates)];
}

function findSubagentRoot(cwd: string): string | undefined {
	for (const candidate of runtimeCandidates(cwd)) {
		if (hasRuntimeModule(candidate)) return candidate;
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

function createDelegatedLiveState(now: number): DelegatedSubagentLiveState {
	return {
		recentOutput: [],
		recentTools: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		taskProgress: [],
		startedAt: now,
		updatedAt: now,
	};
}

export function updateDelegatedLiveState(requestId: string, update: Partial<DelegatedSubagentLiveState>): void {
	const now = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? createDelegatedLiveState(now);
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
	const trimmedLine = line?.trim();
	if (!trimmedLine || trimmedLine === "(running...)") return;

	const now = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? createDelegatedLiveState(now);
	delegatedLiveState.set(requestId, {
		...existing,
		recentOutput: [...existing.recentOutput, line],
		updatedAt: now,
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
			"Delegated prompt execution requires the pi-subagents runtime. Install it with `pi install npm:pi-subagents` (preferred) or set PI_SUBAGENT_RUNTIME_ROOT explicitly.",
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

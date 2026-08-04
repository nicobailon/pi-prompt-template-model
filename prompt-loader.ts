import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseChainDeclaration } from "./chain-parser.ts";

const CONFIG_DIR_NAME = ".pi";
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const RESERVED_COMMAND_NAMES = new Set([
	"chain-prompts",
	"prompt-tool",
	"settings",
	"model",
	"scoped-models",
	"export",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"tree",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
]);

export type PromptSource = "user" | "project";

export interface DelegationLineupSlot {
	agent: string;
	model?: string;
	task?: string;
	taskSuffix?: string;
	cwd?: string;
	count?: number;
}

export type DeterministicHandoff = "always" | "never" | "on-success" | "on-failure";

export type DeterministicExecution =
	| { kind: "run"; command: string }
	| { kind: "command"; command: string; args: string[]; shell: boolean }
	| { kind: "script"; path: string; args: string[] };

export type DeterministicEnv = Record<string, string>;

export interface DeterministicStep {
	execution: DeterministicExecution;
	handoff: DeterministicHandoff;
	nonInteractive: boolean;
	timeoutMs?: number;
	cwd?: string;
	env?: DeterministicEnv;
}

export interface PromptWithModel {
	name: string;
	description: string;
	content: string;
	models: string[];
	chain?: string;
	chainContext?: "summary";
	restore: boolean;
	skill?: string[];
	thinking?: ThinkingLevel;
	thinkingLevels?: ThinkingLevel[];
	rotate?: boolean;
	fresh?: boolean;
	loop?: number | null;
	converge?: boolean;
	boomerang?: boolean;
	parallel?: number;
	worktree?: boolean;
	deterministic?: DeterministicStep;
	subagent?: true | string;
	inheritContext?: boolean;
	cwd?: string;
	workers?: DelegationLineupSlot[];
	reviewers?: DelegationLineupSlot[];
	finalApplier?: DelegationLineupSlot;
	source: PromptSource;
	subdir?: string;
	filePath: string;
}

export interface PromptLoaderDiagnostic {
	code: string;
	message: string;
	filePath: string;
	source: PromptSource;
	key: string;
}

export interface LoadPromptsWithModelResult {
	prompts: Map<string, PromptWithModel>;
	diagnostics: PromptLoaderDiagnostic[];
}

export interface LoadPromptsWithModelOptions {
	includeProjectPrompts?: boolean;
}

export interface ResolveSkillPathOptions {
	includeProjectSkills?: boolean;
}

function createDiagnostic(
	code: string,
	filePath: string,
	source: PromptSource,
	message: string,
): PromptLoaderDiagnostic {
	return {
		code,
		message,
		filePath,
		source,
		key: `${code}:${filePath}:${message}`,
	};
}

function lexicalCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function normalizeStringField(
	field: string,
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSkillNames(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	const entries = typeof value === "string" ? [value] : value;
	if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
		diagnostics.push(
			createDiagnostic(
				"invalid-skill",
				filePath,
				source,
				`Ignoring invalid skill value in ${filePath}: expected a string or an array of strings.`,
			),
		);
		return undefined;
	}

	const skills: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		for (const item of entry.split(",")) {
			const trimmed = item.trim();
			const normalized = (trimmed.startsWith("skill:") ? trimmed.slice("skill:".length) : trimmed).trim();
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			skills.push(normalized);
		}
	}
	return skills.length > 0 ? skills : undefined;
}

function isValidModelSelectionSpec(spec: string): boolean {
	if (!spec || spec.includes("*") || /\s/.test(spec)) return false;

	const slashIndex = spec.indexOf("/");
	if (slashIndex === -1) return true;
	if (slashIndex === 0) return false;
	const modelId = spec.slice(slashIndex + 1);
	if (modelId.length === 0) return false;
	if (modelId.split("/").some((segment) => segment.length === 0)) return false;
	return true;
}

function normalizeFrontmatterRecord(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-frontmatter",
			filePath,
			source,
			`Skipping prompt template at ${filePath}: frontmatter must be a key-value object.`,
		),
	);
	return undefined;
}

function normalizeModelSpecs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" must be a string.`,
			),
		);
		return undefined;
	}

	const models = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (models.length === 0) {
		diagnostics.push(
			createDiagnostic(
				"empty-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" is empty.`,
			),
		);
		return undefined;
	}

	const invalidSpec = models.find((model) => !isValidModelSelectionSpec(model));
	if (invalidSpec) {
		diagnostics.push(
			createDiagnostic(
				"invalid-model-spec",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: invalid model spec ${JSON.stringify(invalidSpec)} in frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return models;
}

function normalizeRestore(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-restore",
			filePath,
			source,
			`Using default restore=true for ${filePath}: frontmatter field "restore" must be true or false.`,
		),
	);
	return true;
}

function normalizeFresh(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-fresh",
			filePath,
			source,
			`Using default fresh=false for ${filePath}: frontmatter field "fresh" must be true or false.`,
		),
	);
	return false;
}

function normalizeRotate(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-rotate",
			filePath,
			source,
			`Using default rotate=false for ${filePath}: frontmatter field "rotate" must be true or false.`,
		),
	);
	return false;
}

function normalizeBoomerang(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-boomerang",
			filePath,
			source,
			`Using default boomerang=false for ${filePath}: frontmatter field "boomerang" must be true or false.`,
		),
	);
	return false;
}

function normalizeLoop(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): number | null | undefined {
	if (value === undefined) return undefined;

	if (value === true || (typeof value === "string" && value.trim().toLowerCase() === "unlimited")) {
		return null;
	}

	let normalizedValue: number | undefined;
	if (typeof value === "number") {
		normalizedValue = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		normalizedValue = parseInt(value.trim(), 10);
	}

	if (normalizedValue !== undefined && Number.isInteger(normalizedValue) && normalizedValue >= 1 && normalizedValue <= 999) {
		return normalizedValue;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-loop",
			filePath,
			source,
			`Ignoring invalid loop value in ${filePath}: frontmatter field "loop" must be an integer between 1 and 999, true, or "unlimited".`,
		),
	);
	return undefined;
}

function normalizeParallel(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): number | undefined {
	if (value === undefined) return undefined;

	let normalizedValue: number | undefined;
	if (typeof value === "number") {
		normalizedValue = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		normalizedValue = parseInt(value.trim(), 10);
	}

	if (normalizedValue !== undefined && Number.isInteger(normalizedValue) && normalizedValue >= 2) {
		return normalizedValue;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-parallel",
			filePath,
			source,
			`Ignoring invalid parallel value in ${filePath}: frontmatter field "parallel" must be an integer greater than or equal to 2.`,
		),
	);
	return undefined;
}

function normalizeStringArrayField(
	field: string,
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected an array of strings.`,
			),
		);
		return undefined;
	}

	const args: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: expected an array of strings.`,
				),
			);
			return undefined;
		}
		args.push(entry);
	}
	return args;
}

function normalizeDeterministicHandoff(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicHandoff {
	if (value === undefined) return "always";
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "always" || normalized === "never" || normalized === "on-success" || normalized === "on-failure") {
			return normalized;
		}
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-deterministic-handoff",
			filePath,
			source,
			`Using default deterministic handoff=always for ${filePath}: expected "always", "never", "on-success", or "on-failure".`,
		),
	);
	return "always";
}

function normalizeTimeoutMs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): number | undefined {
	if (value === undefined) return undefined;
	let timeoutMs: number | undefined;
	if (typeof value === "number") timeoutMs = value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) timeoutMs = parseInt(value.trim(), 10);
	if (timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs >= 1) return timeoutMs;

	diagnostics.push(
		createDiagnostic(
			"invalid-deterministic-timeout",
			filePath,
			source,
			`Ignoring invalid deterministic timeout in ${filePath}: expected an integer greater than or equal to 1 (milliseconds).`,
		),
	);
	return undefined;
}

function normalizeDeterministicEnv(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicEnv | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-env",
				filePath,
				source,
				`Ignoring invalid deterministic env in ${filePath}: expected an object with string/number/boolean values.`,
			),
		);
		return undefined;
	}

	const env: DeterministicEnv = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!key.trim()) {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic-env",
					filePath,
					source,
					`Ignoring invalid deterministic env in ${filePath}: env keys must be non-empty strings.`,
				),
			);
			return undefined;
		}
		if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic-env",
					filePath,
					source,
					`Ignoring invalid deterministic env in ${filePath}: env value for ${JSON.stringify(key)} must be a string, number, or boolean.`,
				),
			);
			return undefined;
		}
		env[key] = String(raw);
	}

	return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeDeterministicNonInteractive(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-deterministic-non-interactive",
			filePath,
			source,
			`Using default deterministic nonInteractive=true for ${filePath}: expected true or false.`,
		),
	);
	return true;
}

function normalizeDeterministicRunValue(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicExecution | undefined {
	if (typeof value === "string") {
		const command = value.trim();
		if (command) return { kind: "run", command };
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-run",
				filePath,
				source,
				`Ignoring invalid deterministic run value in ${filePath}: expected a non-empty string or an object with command/args.`,
			),
		);
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-run",
				filePath,
				source,
				`Ignoring invalid deterministic run value in ${filePath}: expected a non-empty string or an object with command/args.`,
			),
		);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const command = normalizeStringField("deterministic.run.command", record.command, filePath, source, diagnostics);
	if (!command) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-run",
				filePath,
				source,
				`Ignoring invalid deterministic run value in ${filePath}: expected object field "command" to be a non-empty string.`,
			),
		);
		return undefined;
	}
	const args = normalizeStringArrayField("deterministic.run.args", record.args, filePath, source, diagnostics);
	if (!args) return undefined;
	let shell = false;
	if (record.shell !== undefined) {
		if (typeof record.shell === "boolean") {
			shell = record.shell;
		} else {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic-run",
					filePath,
					source,
					`Ignoring invalid deterministic run value in ${filePath}: object field "shell" must be true or false.`,
				),
			);
			return undefined;
		}
	}
	return { kind: "command", command, args, shell };
}

function normalizeDeterministicScriptValue(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicExecution | undefined {
	if (typeof value === "string") {
		const path = value.trim();
		if (path) return { kind: "script", path, args: [] };
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-script",
				filePath,
				source,
				`Ignoring invalid deterministic script value in ${filePath}: expected a non-empty string or an object with path/args.`,
			),
		);
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-script",
				filePath,
				source,
				`Ignoring invalid deterministic script value in ${filePath}: expected a non-empty string or an object with path/args.`,
			),
		);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const path = normalizeStringField("deterministic.script.path", record.path, filePath, source, diagnostics);
	if (!path) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-script",
				filePath,
				source,
				`Ignoring invalid deterministic script value in ${filePath}: expected object field "path" to be a non-empty string.`,
			),
		);
		return undefined;
	}
	const args = normalizeStringArrayField("deterministic.script.args", record.args, filePath, source, diagnostics);
	if (!args) return undefined;
	return { kind: "script", path, args };
}

function normalizeDeterministic(
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicStep | undefined {
	const hasNested = Object.hasOwn(frontmatter, "deterministic");
	const hasRun = Object.hasOwn(frontmatter, "run");
	const hasScript = Object.hasOwn(frontmatter, "script");
	const hasHandoff = Object.hasOwn(frontmatter, "handoff");
	const hasTimeout = Object.hasOwn(frontmatter, "timeout");
	const hasEnv = Object.hasOwn(frontmatter, "env");
	const hasNonInteractive = Object.hasOwn(frontmatter, "nonInteractive");
	if (!hasNested && !hasRun && !hasScript && !hasHandoff && !hasTimeout && !hasEnv && !hasNonInteractive) return undefined;

	if (hasNested && (hasRun || hasScript || hasHandoff || hasTimeout || hasEnv || hasNonInteractive)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-mixed-shorthand",
				filePath,
				source,
				`Ignoring top-level deterministic shorthand in ${filePath}: use either "deterministic" or top-level run/script/handoff/timeout/env/nonInteractive, not both.`,
			),
		);
	}

	let record: Record<string, unknown>;
	if (hasNested) {
		const raw = frontmatter.deterministic;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic",
					filePath,
					source,
					`Ignoring invalid deterministic config in ${filePath}: frontmatter field "deterministic" must be an object.`,
				),
			);
			return undefined;
		}
		record = raw as Record<string, unknown>;
	} else {
		record = {
			run: frontmatter.run,
			script: frontmatter.script,
			handoff: frontmatter.handoff,
			timeout: frontmatter.timeout,
			env: frontmatter.env,
			nonInteractive: frontmatter.nonInteractive,
		};
	}

	const runValue = Object.hasOwn(record, "run") ? record.run : undefined;
	const scriptValue = Object.hasOwn(record, "script") ? record.script : undefined;
	if (runValue !== undefined && scriptValue !== undefined) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic",
				filePath,
				source,
				`Ignoring deterministic config in ${filePath}: "run" and "script" cannot be declared together.`,
			),
		);
		return undefined;
	}

	const execution = runValue !== undefined
		? normalizeDeterministicRunValue(runValue, filePath, source, diagnostics)
		: scriptValue !== undefined
			? normalizeDeterministicScriptValue(scriptValue, filePath, source, diagnostics)
			: undefined;
	if (!execution) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic",
				filePath,
				source,
				`Ignoring deterministic config in ${filePath}: expected either "run" or "script".`,
			),
		);
		return undefined;
	}

	const handoff = normalizeDeterministicHandoff(record.handoff, filePath, source, diagnostics);
	const timeoutMs = normalizeTimeoutMs(record.timeout, filePath, source, diagnostics);
	const cwd = normalizeCwd(record.cwd, filePath, source, diagnostics);
	const env = normalizeDeterministicEnv(record.env, filePath, source, diagnostics);
	const nonInteractive = normalizeDeterministicNonInteractive(record.nonInteractive, filePath, source, diagnostics);
	return {
		execution,
		handoff,
		nonInteractive,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(cwd ? { cwd } : {}),
		...(env ? { env } : {}),
	};
}

function normalizeLineupSlot(
	value: unknown,
	field: "workers" | "reviewers" | "finalApplier",
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
	index: number,
): DelegationLineupSlot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} must be an object.`,
			),
		);
		return undefined;
	}

	const slot = value as Record<string, unknown>;
	if (slot.agent !== undefined && slot.subagent !== undefined) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} cannot combine "agent" and "subagent".`,
			),
		);
		return undefined;
	}

	let agent: string | undefined;
	if (typeof slot.agent === "string" && slot.agent.trim()) {
		agent = slot.agent.trim();
	} else if (slot.agent !== undefined) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} requires a non-empty string "agent".`,
			),
		);
		return undefined;
	}

	if (!agent && slot.subagent !== undefined) {
		if (slot.subagent === true) {
			agent = field === "reviewers" ? "reviewer" : "delegate";
		} else if (typeof slot.subagent === "string" && slot.subagent.trim()) {
			agent = slot.subagent.trim();
		} else {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} requires "subagent" to be true or a non-empty string.`,
				),
			);
			return undefined;
		}
	}

	if (!agent) {
		agent = field === "reviewers" ? "reviewer" : "delegate";
	}

	const normalized: DelegationLineupSlot = {
		agent,
	};

	if (slot.model !== undefined) {
		if (typeof slot.model !== "string" || !slot.model.trim()) {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has an invalid "model".`,
				),
			);
			return undefined;
		}
		const modelSpec = slot.model.trim();
		if (!isValidModelSelectionSpec(modelSpec)) {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has invalid model spec ${JSON.stringify(modelSpec)}.`,
				),
			);
			return undefined;
		}
		normalized.model = modelSpec;
	}

	if (slot.task !== undefined) {
		if (typeof slot.task !== "string") {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has a non-string "task".`,
				),
			);
			return undefined;
		}
		const task = slot.task.trim();
		if (task) normalized.task = task;
	}

	if (slot.taskSuffix !== undefined) {
		if (typeof slot.taskSuffix !== "string") {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has a non-string "taskSuffix".`,
				),
			);
			return undefined;
		}
		const taskSuffix = slot.taskSuffix.trim();
		if (taskSuffix) normalized.taskSuffix = taskSuffix;
	}

	if (slot.cwd !== undefined) {
		if (typeof slot.cwd !== "string") {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has a non-string "cwd".`,
				),
			);
			return undefined;
		}
		const cwdRaw = slot.cwd.trim();
		if (cwdRaw) {
			const expanded = expandCwdPath(cwdRaw);
			if (!expanded) {
				diagnostics.push(
					createDiagnostic(
						`invalid-${field}`,
						filePath,
						source,
						`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} "cwd" must be an absolute path.`,
					),
				);
				return undefined;
			}
			normalized.cwd = expanded;
		}
	}

	if (slot.count !== undefined) {
		let count: number | undefined;
		if (typeof slot.count === "number") {
			count = slot.count;
		} else if (typeof slot.count === "string" && /^\d+$/.test(slot.count.trim())) {
			count = parseInt(slot.count.trim(), 10);
		}
		if (count === undefined || !Number.isInteger(count) || count < 1) {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} "count" must be an integer greater than or equal to 1.`,
				),
			);
			return undefined;
		}
		normalized.count = count;
	}

	return normalized;
}

function normalizeLineup(
	value: unknown,
	field: "workers" | "reviewers",
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DelegationLineupSlot[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected an array of slot objects.`,
			),
		);
		return undefined;
	}
	if (value.length === 0) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected at least one slot.`,
			),
		);
		return undefined;
	}

	const slots: DelegationLineupSlot[] = [];
	for (let i = 0; i < value.length; i++) {
		const normalized = normalizeLineupSlot(value[i], field, filePath, source, diagnostics, i);
		if (!normalized) return undefined;
		slots.push(normalized);
	}
	return slots;
}

function normalizeFinalApplier(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DelegationLineupSlot | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeLineupSlot(value, "finalApplier", filePath, source, diagnostics, 0);
	if (!normalized) return undefined;
	const slot = value as Record<string, unknown>;
	if (Object.hasOwn(slot, "count")) {
		diagnostics.push(
			createDiagnostic(
				"invalid-final-applier",
				filePath,
				source,
				`Ignoring invalid finalApplier value in ${filePath}: slot 1 "count" is not supported.`,
			),
		);
		return undefined;
	}
	if (Object.hasOwn(slot, "cwd")) {
		diagnostics.push(
			createDiagnostic(
				"invalid-final-applier",
				filePath,
				source,
				`Ignoring invalid finalApplier value in ${filePath}: slot 1 "cwd" is not supported.`,
			),
		);
		return undefined;
	}
	return normalized;
}

function normalizeBestOfN(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-best-of-n",
			filePath,
			source,
			`Ignoring invalid bestOfN value in ${filePath}: frontmatter field "bestOfN" must be an object.`,
		),
	);
	return undefined;
}

function pushLegacyCompareFieldDiagnostic(
	field: "workers" | "reviewers" | "finalApplier",
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
) {
	diagnostics.push(
		createDiagnostic(
			`invalid-${field}`,
			filePath,
			source,
			`Ignoring top-level ${field} in ${filePath}: compare template authoring moved to "bestOfN.${field}".`,
		),
	);
}

function normalizeConverge(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-converge",
			filePath,
			source,
			`Using default converge=true for ${filePath}: frontmatter field "converge" must be true or false.`,
		),
	);
	return true;
}

function normalizeWorktree(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-worktree",
			filePath,
			source,
			`Using default worktree=false for ${filePath}: frontmatter field "worktree" must be true or false.`,
		),
	);
	return false;
}

function normalizeSubagent(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): true | string | undefined {
	if (value === undefined) return undefined;
	if (value === true) return true;
	if (value === false) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-subagent",
				filePath,
				source,
				`Ignoring invalid subagent value in ${filePath}: frontmatter field "subagent" must be true or a non-empty string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	if (!normalized) {
		diagnostics.push(
			createDiagnostic(
				"invalid-subagent",
				filePath,
				source,
				`Ignoring invalid subagent value in ${filePath}: frontmatter field "subagent" must be true or a non-empty string.`,
			),
		);
		return undefined;
	}
	return normalized;
}

export function expandCwdPath(raw: string): string | undefined {
	const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : undefined;
}

function normalizeCwd(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-cwd",
				filePath,
				source,
				`Ignoring invalid cwd in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const expanded = expandCwdPath(trimmed);
	if (!expanded) {
		diagnostics.push(
			createDiagnostic(
				"invalid-cwd",
				filePath,
				source,
				`Ignoring cwd in ${filePath}: must be an absolute path.`,
			),
		);
		return undefined;
	}
	return expanded;
}

function normalizeInheritContext(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-inherit-context",
			filePath,
			source,
			`Using default inheritContext=false for ${filePath}: frontmatter field "inheritContext" must be true or false.`,
		),
	);
	return false;
}

function normalizeChain(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-chain",
				filePath,
				source,
				`Ignoring invalid chain value in ${filePath}: frontmatter field "chain" must be a string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	if (normalized.length > 0) return normalized;

	diagnostics.push(
		createDiagnostic(
			"empty-chain",
			filePath,
			source,
			`Ignoring invalid chain value in ${filePath}: frontmatter field "chain" must be a non-empty string.`,
		),
	);
	return undefined;
}

function normalizeChainContext(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): "summary" | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "summary") return "summary";
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-chain-context",
			filePath,
			source,
			`Ignoring invalid chainContext value in ${filePath}: frontmatter field "chainContext" must be "summary".`,
		),
	);
	return undefined;
}

function normalizeThinking(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel | undefined {
	const thinking = normalizeStringField("thinking", value, filePath, source, diagnostics);
	if (thinking === undefined) return undefined;

	const normalized = thinking.toLowerCase();
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(normalized)) {
		return normalized as ThinkingLevel;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-thinking",
			filePath,
			source,
			`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(thinking)}.`,
		),
	);
	return undefined;
}

function normalizeThinkingLevels(
	value: unknown,
	modelCount: number,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel[] | undefined {
	if (typeof value !== "string") return undefined;

	const levels = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	const invalidLevel = levels.find((level) => !(VALID_THINKING_LEVELS as readonly string[]).includes(level.toLowerCase()));
	if (invalidLevel) {
		diagnostics.push(
			createDiagnostic(
				"invalid-thinking-levels",
				filePath,
				source,
				`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(invalidLevel)}.`,
			),
		);
		return undefined;
	}

	if (levels.length !== modelCount) {
		diagnostics.push(
			createDiagnostic(
				"invalid-thinking-level-count",
				filePath,
				source,
				`Ignoring comma-separated thinking levels in ${filePath}: expected ${modelCount} entries to match frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return levels.map((level) => level.toLowerCase() as ThinkingLevel);
}

interface ConfiguredPromptPath {
	rawPath: string;
	resolvedPath: string;
	settingsPath: string;
	source: PromptSource;
	baseDir: string;
	patterns: string[];
}

interface ConfiguredPromptPaths {
	paths: ConfiguredPromptPath[];
	patterns: string[];
}

function expandConfiguredPromptPath(rawPath: string, baseDir: string): string {
	const trimmed = rawPath.trim();
	const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function isSettingsPromptPattern(value: string): boolean {
	return value.startsWith("!") || value.startsWith("+") || value.startsWith("-") || value.includes("*") || value.includes("?");
}

function isSettingsPromptOverridePattern(value: string): boolean {
	return value.startsWith("!") || value.startsWith("+") || value.startsWith("-");
}

function toPosixPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function normalizeExactPromptPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesPromptPattern(filePath: string, pattern: string, baseDir: string): boolean {
	const normalizedPattern = toPosixPath(pattern);
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	return [rel, name, filePathPosix].some((candidate) => minimatch(candidate, normalizedPattern));
}

function matchesExactPromptPattern(filePath: string, pattern: string, baseDir: string): boolean {
	const normalizedPattern = normalizeExactPromptPattern(pattern);
	const rel = toPosixPath(relative(baseDir, filePath));
	const filePathPosix = toPosixPath(filePath);
	return normalizedPattern === rel || normalizedPattern === filePathPosix;
}

function shouldLoadPromptFile(filePath: string, patterns: string[], baseDir: string): boolean {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const pattern of patterns) {
		if (pattern.startsWith("+")) {
			forceIncludes.push(pattern.slice(1));
		} else if (pattern.startsWith("-")) {
			forceExcludes.push(pattern.slice(1));
		} else if (pattern.startsWith("!")) {
			excludes.push(pattern.slice(1));
		} else {
			includes.push(pattern);
		}
	}

	let enabled = includes.length === 0 || includes.some((pattern) => matchesPromptPattern(filePath, pattern, baseDir));
	if (excludes.some((pattern) => matchesPromptPattern(filePath, pattern, baseDir))) enabled = false;
	if (forceIncludes.some((pattern) => matchesExactPromptPattern(filePath, pattern, baseDir))) enabled = true;
	if (forceExcludes.some((pattern) => matchesExactPromptPattern(filePath, pattern, baseDir))) enabled = false;
	return enabled;
}

function createPromptFileFilter(patterns: string[], baseDir: string): ((filePath: string) => boolean) | undefined {
	return patterns.length === 0 ? undefined : (filePath) => shouldLoadPromptFile(filePath, patterns, baseDir);
}

function loadConfiguredPromptPaths(
	settingsPath: string,
	source: PromptSource,
	baseDir: string,
	diagnostics: PromptLoaderDiagnostic[],
): ConfiguredPromptPaths {
	if (!existsSync(settingsPath)) return { paths: [], patterns: [] };

	let rawSettings: string;
	try {
		rawSettings = readFileSync(settingsPath, "utf-8");
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-settings",
				settingsPath,
				source,
				`Skipping prompt settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { paths: [], patterns: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawSettings);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"invalid-settings-json",
				settingsPath,
				source,
				`Skipping prompt settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { paths: [], patterns: [] };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-settings",
				settingsPath,
				source,
				`Skipping prompt settings at ${settingsPath}: settings must be a JSON object.`,
			),
		);
		return { paths: [], patterns: [] };
	}

	const prompts = (parsed as Record<string, unknown>).prompts;
	if (prompts === undefined) return { paths: [], patterns: [] };
	if (!Array.isArray(prompts)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-settings-prompts",
				settingsPath,
				source,
				`Ignoring prompts in ${settingsPath}: expected "prompts" to be an array of strings.`,
			),
		);
		return { paths: [], patterns: [] };
	}

	const configuredPaths: Omit<ConfiguredPromptPath, "patterns">[] = [];
	const patterns: string[] = [];
	for (let index = 0; index < prompts.length; index++) {
		const rawPath = prompts[index];
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			diagnostics.push(
				createDiagnostic(
					"invalid-settings-prompt-entry",
					settingsPath,
					source,
					`Ignoring prompts[${index}] in ${settingsPath}: expected a non-empty string.`,
				),
			);
			continue;
		}

		const trimmed = rawPath.trim();
		if (isSettingsPromptPattern(trimmed)) {
			patterns.push(trimmed);
			continue;
		}
		configuredPaths.push({
			rawPath: trimmed,
			resolvedPath: expandConfiguredPromptPath(trimmed, baseDir),
			settingsPath,
			source,
			baseDir,
		});
	}

	return { paths: configuredPaths.map((path) => ({ ...path, patterns })), patterns };
}

function canonicalizePromptFile(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch {
		return resolve(filePath);
	}
}

function loadPromptsWithModelFromDir(
	dir: string,
	source: PromptSource,
	includePlainPrompts: boolean,
	subdir = "",
	visitedDirectories = new Set<string>(),
	onlyFileName?: string,
	seenFiles?: Set<string>,
	shouldLoadFile?: (filePath: string) => boolean,
): { prompts: PromptWithModel[]; diagnostics: PromptLoaderDiagnostic[] } {
	const prompts: PromptWithModel[] = [];
	const diagnostics: PromptLoaderDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { prompts, diagnostics };
	}

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { prompts, diagnostics };
	}

	if (visitedDirectories.has(canonicalDir)) {
		diagnostics.push(
			createDiagnostic(
				"directory-cycle",
				dir,
				source,
				`Skipping already visited prompt directory at ${dir}.`,
			),
		);
		return { prompts, diagnostics };
	}

	visitedDirectories.add(canonicalDir);

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name));

		for (const entry of entries) {
			if (onlyFileName && entry.name !== onlyFileName) continue;
			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
					isDirectory = stats.isDirectory();
				} catch (error) {
					diagnostics.push(
						createDiagnostic(
							"unreadable-symlink",
							fullPath,
							source,
							`Skipping unreadable symlink at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
						),
					);
					continue;
				}
			}

			if (isDirectory) {
				if (onlyFileName) continue;
				const nextSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				const nested = loadPromptsWithModelFromDir(fullPath, source, includePlainPrompts, nextSubdir, visitedDirectories, undefined, seenFiles, shouldLoadFile);
				prompts.push(...nested.prompts);
				diagnostics.push(...nested.diagnostics);
				continue;
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;
			if (shouldLoadFile && !shouldLoadFile(fullPath)) continue;
			const canonicalFile = canonicalizePromptFile(fullPath);
			if (seenFiles?.has(canonicalFile)) continue;
			seenFiles?.add(canonicalFile);

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const parsed = parseFrontmatter<Record<string, unknown>>(rawContent);
				const frontmatter = normalizeFrontmatterRecord(parsed.frontmatter, fullPath, source, diagnostics);
				if (!frontmatter) continue;
				const { body } = parsed;
				const chain = normalizeChain(frontmatter.chain, fullPath, source, diagnostics);
				let parsedChainDeclarationResult:
					| ReturnType<typeof parseChainDeclaration>
					| undefined;
				const chainContext = chain ? normalizeChainContext(frontmatter.chainContext, fullPath, source, diagnostics) : undefined;
				if (chain && /\bparallel\s*\(/.test(chain)) {
					parsedChainDeclarationResult = parseChainDeclaration(chain);
					if (parsedChainDeclarationResult.invalidSegments.length > 0 || parsedChainDeclarationResult.steps.length === 0) {
						diagnostics.push(
							createDiagnostic(
								"invalid-chain-declaration",
								fullPath,
								source,
								`Skipping prompt template at ${fullPath}: invalid chain declaration segment ${JSON.stringify(parsedChainDeclarationResult.invalidSegments[0] ?? chain)}.`,
							),
						);
						continue;
					}
				}
				let subagent = normalizeSubagent(frontmatter.subagent, fullPath, source, diagnostics);
				const cwd = normalizeCwd(frontmatter.cwd, fullPath, source, diagnostics);
				const inheritContext = normalizeInheritContext(frontmatter.inheritContext, fullPath, source, diagnostics);
				const parallel = normalizeParallel(frontmatter.parallel, fullPath, source, diagnostics);
				const hasBestOfN = Object.hasOwn(frontmatter, "bestOfN");
				const bestOfN = normalizeBestOfN(frontmatter.bestOfN, fullPath, source, diagnostics);
				let deterministic = normalizeDeterministic(frontmatter, fullPath, source, diagnostics);
				const hasLegacyWorkers = Object.hasOwn(frontmatter, "workers");
				const hasLegacyReviewers = Object.hasOwn(frontmatter, "reviewers");
				const hasLegacyFinalApplier = Object.hasOwn(frontmatter, "finalApplier");
				const hasLegacyCompareFields = hasLegacyWorkers || hasLegacyReviewers || hasLegacyFinalApplier;
				if (hasLegacyWorkers) {
					pushLegacyCompareFieldDiagnostic("workers", fullPath, source, diagnostics);
				}
				if (hasLegacyReviewers) {
					pushLegacyCompareFieldDiagnostic("reviewers", fullPath, source, diagnostics);
				}
				if (hasLegacyFinalApplier) {
					pushLegacyCompareFieldDiagnostic("finalApplier", fullPath, source, diagnostics);
				}
				if (hasBestOfN && Object.hasOwn(frontmatter, "worktree")) {
					diagnostics.push(
						createDiagnostic(
							"invalid-worktree",
							fullPath,
							source,
							`Ignoring top-level worktree in ${fullPath}: use "bestOfN.worktree" for compare template authoring.`,
						),
					);
				}
				const workers = normalizeLineup(hasBestOfN ? bestOfN?.workers : undefined, "workers", fullPath, source, diagnostics);
				const reviewers = normalizeLineup(hasBestOfN ? bestOfN?.reviewers : undefined, "reviewers", fullPath, source, diagnostics);
				const finalApplier = normalizeFinalApplier(hasBestOfN ? bestOfN?.finalApplier : undefined, fullPath, source, diagnostics);
				let safeWorkers = workers;
				let safeReviewers = reviewers;
				let safeFinalApplier = finalApplier;
				if (chain && subagent !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-subagent-chain",
							fullPath,
							source,
							`Ignoring subagent in ${fullPath}: frontmatter fields "chain" and "subagent" cannot be combined.`,
						),
					);
					subagent = undefined;
				}
				if (chain && deterministic !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-deterministic-chain",
							fullPath,
							source,
							`Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "chain".`,
						),
					);
					deterministic = undefined;
				}
				if (chain && (safeWorkers !== undefined || safeReviewers !== undefined || safeFinalApplier !== undefined)) {
					diagnostics.push(
						createDiagnostic(
							"invalid-lineup-chain",
							fullPath,
							source,
							`Ignoring compare lineup config in ${fullPath}: frontmatter fields "workers"/"reviewers"/"finalApplier" cannot be combined with "chain".`,
						),
					);
					safeWorkers = undefined;
					safeReviewers = undefined;
					safeFinalApplier = undefined;
				}
				if (subagent !== undefined && (safeWorkers !== undefined || safeReviewers !== undefined || safeFinalApplier !== undefined)) {
					diagnostics.push(
						createDiagnostic(
							"invalid-lineup-subagent",
							fullPath,
							source,
							`Ignoring compare lineup config in ${fullPath}: frontmatter fields "workers"/"reviewers"/"finalApplier" cannot be combined with "subagent".`,
						),
					);
					safeWorkers = undefined;
					safeReviewers = undefined;
					safeFinalApplier = undefined;
				}
				if (subagent !== undefined && deterministic !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-deterministic-subagent",
							fullPath,
							source,
							`Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "subagent".`,
						),
					);
					deterministic = undefined;
				}
				if (subagent === undefined && inheritContext) {
					diagnostics.push(
						createDiagnostic(
							"invalid-inherit-context",
							fullPath,
							source,
							`Ignoring inheritContext in ${fullPath}: frontmatter field "inheritContext" requires "subagent".`,
						),
					);
				}
				let safeParallel = parallel;
				if (safeParallel !== undefined && chain) {
					diagnostics.push(
						createDiagnostic(
							"invalid-parallel",
							fullPath,
							source,
							`Ignoring parallel in ${fullPath}: frontmatter field "parallel" cannot be combined with "chain".`,
						),
					);
					safeParallel = undefined;
				}
				if (safeParallel !== undefined && subagent === undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-parallel",
							fullPath,
							source,
							`Ignoring parallel in ${fullPath}: frontmatter field "parallel" requires "subagent".`,
						),
					);
					safeParallel = undefined;
				}
				if (safeParallel !== undefined && (safeWorkers !== undefined || safeReviewers !== undefined || safeFinalApplier !== undefined)) {
					diagnostics.push(
						createDiagnostic(
							"invalid-lineup-parallel",
							fullPath,
							source,
							`Ignoring compare lineup config in ${fullPath}: frontmatter fields "workers"/"reviewers"/"finalApplier" cannot be combined with "parallel".`,
						),
					);
					safeWorkers = undefined;
					safeReviewers = undefined;
					safeFinalApplier = undefined;
				}
				if (safeParallel !== undefined && deterministic !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-deterministic-parallel",
							fullPath,
							source,
							`Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "parallel".`,
						),
					);
					deterministic = undefined;
				}
				const hasLineup = safeWorkers !== undefined || safeReviewers !== undefined || safeFinalApplier !== undefined;
				if (!hasBestOfN && hasLegacyCompareFields) {
					diagnostics.push(
						createDiagnostic(
							"invalid-compare-frontmatter",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: compare template authoring moved under "bestOfN:".`,
						),
					);
					continue;
				}
				if (hasBestOfN && !hasLineup) {
					diagnostics.push(
						createDiagnostic(
							"invalid-best-of-n",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: "bestOfN" did not produce a valid compare configuration.`,
						),
					);
					continue;
				}
				if (!chain && subagent === undefined && !hasLineup && cwd) {
					if (deterministic) {
						deterministic = { ...deterministic, ...(deterministic.cwd ? {} : { cwd }) };
					} else {
						diagnostics.push(
							createDiagnostic(
								"invalid-cwd",
								fullPath,
								source,
								`Ignoring cwd in ${fullPath}: frontmatter field "cwd" requires "subagent", "chain", or compare lineups ("workers"/"reviewers"/"finalApplier").`,
							),
						);
					}
				}
				const hasModelField = Object.hasOwn(frontmatter, "model");
				const parsedModels = chain ? [] : normalizeModelSpecs(frontmatter.model, fullPath, source, diagnostics);
				if (!chain && hasModelField && !parsedModels) continue;
				const models = chain ? [] : (parsedModels ?? []);
				const rotate = chain ? false : normalizeRotate(frontmatter.rotate, fullPath, source, diagnostics);

				const name = entry.name.slice(0, -3);
				if (RESERVED_COMMAND_NAMES.has(name)) {
					diagnostics.push(
						createDiagnostic(
							"reserved-command-name",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: command name "${name}" is reserved.`,
						),
					);
					continue;
				}

				const safeInheritContext = subagent !== undefined && inheritContext;
				const safeCwd = (chain || subagent !== undefined || hasLineup) ? cwd : undefined;
				const description = normalizeStringField("description", frontmatter.description, fullPath, source, diagnostics) ?? "";
				const skill = chain ? undefined : normalizeSkillNames(frontmatter.skill, fullPath, source, diagnostics);
				let thinking: ThinkingLevel | undefined;
				let thinkingLevels: ThinkingLevel[] | undefined;
				if (!chain) {
					if (rotate && typeof frontmatter.thinking === "string" && frontmatter.thinking.includes(",")) {
						thinkingLevels = normalizeThinkingLevels(frontmatter.thinking, models.length, fullPath, source, diagnostics);
					} else {
						thinking = normalizeThinking(frontmatter.thinking, fullPath, source, diagnostics);
					}
				}
				const restore = normalizeRestore(frontmatter.restore, fullPath, source, diagnostics);
				const fresh = normalizeFresh(frontmatter.fresh, fullPath, source, diagnostics);
				const loop = normalizeLoop(frontmatter.loop, fullPath, source, diagnostics);
				const converge = normalizeConverge(frontmatter.converge, fullPath, source, diagnostics);
				let boomerang = normalizeBoomerang(frontmatter.boomerang, fullPath, source, diagnostics);
				if (chain && boomerang) {
					diagnostics.push(
						createDiagnostic(
							"invalid-boomerang-chain",
							fullPath,
							source,
							`Ignoring boomerang in ${fullPath}: frontmatter fields "chain" and "boomerang" cannot be combined.`,
						),
					);
					boomerang = false;
				}
				if (loop !== undefined && deterministic !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-deterministic-loop",
							fullPath,
							source,
							`Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "loop" in v1.`,
						),
					);
					deterministic = undefined;
				}
				const worktreeInput = hasBestOfN ? bestOfN?.worktree : frontmatter.worktree;
				const worktree = normalizeWorktree(worktreeInput, fullPath, source, diagnostics);
				let safeWorktree: boolean | undefined;
				if (worktree) {
					if (chain) {
						const parsedChain = parsedChainDeclarationResult ?? parseChainDeclaration(chain);
						const hasParallelStep = parsedChain.steps.some((step) => "parallel" in step);
						if (parsedChain.invalidSegments.length > 0 || parsedChain.steps.length === 0 || !hasParallelStep) {
							diagnostics.push(
								createDiagnostic(
									"invalid-worktree",
									fullPath,
									source,
									`Ignoring worktree in ${fullPath}: frontmatter field "worktree" requires either "chain" with at least one parallel() step, "subagent" with frontmatter field "parallel", or compare lineups ("workers"/"reviewers"/"finalApplier").`,
								),
							);
						} else {
							safeWorktree = true;
						}
					} else if (subagent !== undefined && safeParallel !== undefined) {
						safeWorktree = true;
					} else if (hasLineup) {
						safeWorktree = true;
					} else {
						diagnostics.push(
							createDiagnostic(
								"invalid-worktree",
								fullPath,
								source,
								`Ignoring worktree in ${fullPath}: frontmatter field "worktree" requires either "chain" with at least one parallel() step, "subagent" with frontmatter field "parallel", or compare lineups ("workers"/"reviewers"/"finalApplier").`,
							),
						);
					}
				}
				const hasModelConditionalDirectives = /<if-model(?:\s|>)|<else(?:\s|>)|<\/if-model\s*>|<\/else(?:\s|>)/.test(body);
				const hasExtensionSpecificConfig =
					skill !== undefined ||
					thinking !== undefined ||
					fresh === true ||
					loop !== undefined ||
					converge === false ||
					boomerang === true ||
					safeParallel !== undefined ||
					deterministic !== undefined ||
					hasLineup ||
					safeWorktree === true ||
					subagent !== undefined ||
					safeInheritContext ||
					hasModelConditionalDirectives;
				if (!chain && !hasModelField && !hasExtensionSpecificConfig && !includePlainPrompts) {
					continue;
				}

				prompts.push({
					name,
					description,
					content: body,
					models,
					chain: chain || undefined,
					chainContext,
					restore,
					skill,
					thinking,
					thinkingLevels,
					rotate: rotate || undefined,
					fresh: fresh || undefined,
					loop: loop !== undefined ? loop : undefined,
					converge: converge === false ? false : undefined,
					boomerang: boomerang || undefined,
					parallel: safeParallel,
					worktree: safeWorktree,
					deterministic,
					subagent,
					inheritContext: safeInheritContext || undefined,
					cwd: safeCwd || undefined,
					workers: safeWorkers,
					reviewers: safeReviewers,
					finalApplier: safeFinalApplier,
					source,
					subdir: subdir || undefined,
					filePath: fullPath,
				});
			} catch (error) {
				diagnostics.push(
					createDiagnostic(
						"invalid-prompt-file",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
					),
				);
			}
		}
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
	}

	return { prompts, diagnostics };
}

function loadPromptsWithModelFromConfiguredPath(
	configuredPath: ConfiguredPromptPath,
	includePlainPrompts: boolean,
	seenFiles: Set<string>,
): { prompts: PromptWithModel[]; diagnostics: PromptLoaderDiagnostic[] } {
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const { rawPath, resolvedPath, settingsPath, source, baseDir, patterns } = configuredPath;
	const shouldLoadFile = createPromptFileFilter(patterns, baseDir);

	if (!existsSync(resolvedPath)) {
		diagnostics.push(
			createDiagnostic(
				"missing-prompt-path",
				resolvedPath,
				source,
				`Skipping configured prompt path ${JSON.stringify(rawPath)} from ${settingsPath}: resolved path ${resolvedPath} does not exist.`,
			),
		);
		return { prompts: [], diagnostics };
	}

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(resolvedPath);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-prompt-path",
				resolvedPath,
				source,
				`Skipping configured prompt path ${JSON.stringify(rawPath)} from ${settingsPath}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { prompts: [], diagnostics };
	}

	if (stats.isDirectory()) {
		return loadPromptsWithModelFromDir(resolvedPath, source, includePlainPrompts, "", new Set<string>(), undefined, seenFiles, shouldLoadFile);
	}

	if (!stats.isFile() || !resolvedPath.endsWith(".md")) {
		diagnostics.push(
			createDiagnostic(
				"invalid-prompt-path",
				resolvedPath,
				source,
				`Skipping configured prompt path ${JSON.stringify(rawPath)} from ${settingsPath}: expected a directory or .md file.`,
			),
		);
		return { prompts: [], diagnostics };
	}

	return loadPromptsWithModelFromDir(dirname(resolvedPath), source, includePlainPrompts, "", new Set<string>(), basename(resolvedPath), seenFiles, shouldLoadFile);
}

export function loadPromptsWithModel(
	cwd: string,
	includePlainPrompts = false,
	options: LoadPromptsWithModelOptions = {},
): LoadPromptsWithModelResult {
	const agentDir = getAgentDir();
	const globalDir = join(agentDir, "prompts");
	const projectBaseDir = resolve(cwd, CONFIG_DIR_NAME);
	const projectDir = join(projectBaseDir, "prompts");
	const promptMap = new Map<string, PromptWithModel>();
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const seenPromptFiles = new Set<string>();

	function addPrompt(prompt: PromptWithModel) {
		const existing = promptMap.get(prompt.name);
		if (!existing) {
			promptMap.set(prompt.name, prompt);
			return;
		}

		if (existing.source === prompt.source) {
			diagnostics.push(
				createDiagnostic(
					"duplicate-command-name",
					prompt.filePath,
					prompt.source,
					`Skipping ${prompt.source} prompt template "${prompt.name}" at ${prompt.filePath} because it conflicts with ${existing.filePath}.`,
				),
			);
		}
	}

	function addResult(result: { prompts: PromptWithModel[]; diagnostics: PromptLoaderDiagnostic[] }) {
		diagnostics.push(...result.diagnostics);
		for (const prompt of result.prompts) {
			addPrompt(prompt);
		}
	}

	const includeProjectPrompts = options.includeProjectPrompts !== false;
	const projectSettingsPaths = includeProjectPrompts
		? loadConfiguredPromptPaths(join(projectBaseDir, "settings.json"), "project", projectBaseDir, diagnostics)
		: { paths: [], patterns: [] };
	const globalSettingsPaths = loadConfiguredPromptPaths(join(agentDir, "settings.json"), "user", agentDir, diagnostics);
	const projectDefaultFilter = createPromptFileFilter(projectSettingsPaths.patterns.filter(isSettingsPromptOverridePattern), projectBaseDir);
	const globalDefaultFilter = createPromptFileFilter(globalSettingsPaths.patterns.filter(isSettingsPromptOverridePattern), agentDir);

	if (includeProjectPrompts) {
		for (const configuredPath of projectSettingsPaths.paths) {
			addResult(loadPromptsWithModelFromConfiguredPath(configuredPath, includePlainPrompts, seenPromptFiles));
		}
		addResult(loadPromptsWithModelFromDir(projectDir, "project", includePlainPrompts, "", new Set<string>(), undefined, seenPromptFiles, projectDefaultFilter));
	}
	for (const configuredPath of globalSettingsPaths.paths) {
		addResult(loadPromptsWithModelFromConfiguredPath(configuredPath, includePlainPrompts, seenPromptFiles));
	}
	addResult(loadPromptsWithModelFromDir(globalDir, "user", includePlainPrompts, "", new Set<string>(), undefined, seenPromptFiles, globalDefaultFilter));

	return { prompts: promptMap, diagnostics };
}

function effectiveLineupCount(slots: DelegationLineupSlot[] | undefined): number {
	return slots?.reduce((total, slot) => total + (slot.count ?? 1), 0) ?? 0;
}

export function buildPromptCommandDescription(prompt: PromptWithModel): string {
	const sourceLabel = prompt.subdir ? `(${prompt.source}:${prompt.subdir})` : `(${prompt.source})`;
	if (prompt.chain) {
		const chainContextLabel = prompt.chainContext ? ` ${prompt.chainContext}` : "";
		const cwdLabel = prompt.cwd ? ` cwd:${prompt.cwd}` : "";
		const worktreeLabel = prompt.worktree ? " worktree" : "";
		const details = `[chain: ${prompt.chain}${chainContextLabel}${cwdLabel}${worktreeLabel}] ${sourceLabel}`;
		return prompt.description ? `${prompt.description} ${details}` : details;
	}
	const modelLabel = prompt.models.length > 0 ? prompt.models.map((model) => model.split("/").pop() || model).join("|") : "current";
	const rotateLabel = prompt.rotate ? " rotate" : "";
	const skillLabel = prompt.skill ? ` +${prompt.skill.join(",")}` : "";
	const thinkingValue = prompt.thinkingLevels ? prompt.thinkingLevels.join(",") : prompt.thinking;
	const thinkingLabel = thinkingValue ? ` ${thinkingValue}` : "";
	const loopLabel = prompt.loop !== undefined ? ` loop:${prompt.loop === null ? "unlimited" : prompt.loop}` : "";
	const boomerangLabel = prompt.boomerang ? " boomerang" : "";
	const subagentLabel = prompt.subagent ? ` subagent:${prompt.subagent === true ? "delegate" : prompt.subagent}` : "";
	const parallelLabel = prompt.parallel !== undefined ? ` parallel:${prompt.parallel}` : "";
	const deterministicLabel = prompt.deterministic ? ` deterministic-step:${prompt.deterministic.handoff}` : "";
	const workersLabel = prompt.workers ? ` workers:${effectiveLineupCount(prompt.workers)}` : "";
	const reviewersLabel = prompt.reviewers ? ` reviewers:${effectiveLineupCount(prompt.reviewers)}` : "";
	const finalApplierLabel = prompt.finalApplier ? " final-applier" : "";
	const cwdLabel = prompt.cwd ? ` cwd:${prompt.cwd}` : "";
	const inheritContextLabel = prompt.inheritContext ? " fork" : "";
	const worktreeLabel = prompt.worktree ? " worktree" : "";
	const details =
		`[${modelLabel}${rotateLabel}${thinkingLabel}${skillLabel}${loopLabel}${boomerangLabel}${subagentLabel}${parallelLabel}${deterministicLabel}${workersLabel}${reviewersLabel}${finalApplierLabel}${cwdLabel}${inheritContextLabel}${worktreeLabel}] ${sourceLabel}`;
	return prompt.description ? `${prompt.description} ${details}` : details;
}

function getSkillCandidates(baseDir: string, skillName: string): string[] {
	return [join(baseDir, skillName, "SKILL.md"), join(baseDir, `${skillName}.md`)];
}

function* walkAncestors(startDir: string, stopDir?: string): Generator<string> {
	let current = startDir;
	while (true) {
		yield current;
		if (stopDir && current === stopDir) return;
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function findRepoRoot(startDir: string): string | undefined {
	for (const dir of walkAncestors(startDir)) {
		if (existsSync(join(dir, ".git"))) return dir;
	}
	return undefined;
}

function findFirstExisting(paths: string[]): string | undefined {
	for (const path of paths) {
		if (existsSync(path)) return path;
	}
	return undefined;
}

export function resolveSkillPath(
	skillName: string,
	cwd: string,
	options: ResolveSkillPathOptions = {},
): string | undefined {
	const projectDir = resolve(cwd);

	if (options.includeProjectSkills !== false) {
		const projectPiSkill = findFirstExisting(getSkillCandidates(resolve(projectDir, CONFIG_DIR_NAME, "skills"), skillName));
		if (projectPiSkill) return projectPiSkill;

		const repoRoot = findRepoRoot(projectDir);
		for (const dir of walkAncestors(projectDir, repoRoot)) {
			const projectAgentsSkill = findFirstExisting(getSkillCandidates(join(dir, ".agents", "skills"), skillName));
			if (projectAgentsSkill) return projectAgentsSkill;
		}
	}

	const globalPiSkill = findFirstExisting(getSkillCandidates(join(getAgentDir(), "skills"), skillName));
	if (globalPiSkill) return globalPiSkill;

	return findFirstExisting(getSkillCandidates(join(homedir(), ".agents", "skills"), skillName));
}

export function readSkillContent(skillPath: string): string {
	const raw = readFileSync(skillPath, "utf-8");
	return parseFrontmatter(raw).body;
}

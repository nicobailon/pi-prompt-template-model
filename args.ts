export interface LoopExtraction {
	args: string;
	loopCount: number | null;
	fresh: boolean;
	converge: boolean;
}

export interface LoopFlags {
	args: string;
	fresh: boolean;
	converge: boolean;
}

export interface SubagentOverride {
	enabled: true;
	agent?: string;
}

export interface SubagentOverrideExtraction {
	args: string;
	override?: SubagentOverride;
	cwd?: string;
	model?: string;
	fork?: boolean;
}

export interface LineupOverrideSlot {
	agent: string;
	model?: string;
	task?: string;
	taskSuffix?: string;
	cwd?: string;
	count?: number;
}

export interface LineupOverrideAction {
	target: "workers" | "reviewers" | "finalApplier";
	mode: "replace" | "append";
	slots: LineupOverrideSlot[];
}

export interface LineupOverrideExtraction {
	args: string;
	actions: LineupOverrideAction[];
	errors: string[];
}

interface ArgToken {
	token: string;
	start: number;
	end: number;
}

function getUnquotedTokens(argsString: string): ArgToken[] {
	const tokens: ArgToken[] = [];
	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const start = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		tokens.push({ token: argsString.slice(start, i), start, end: i });
	}
	return tokens;
}

function removeTokenRanges(argsString: string, ranges: Array<{ start: number; end: number }>): string {
	let cleaned = argsString;
	for (const { start, end } of [...ranges].sort((a, b) => b.start - a.start)) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}
	return cleaned.trim();
}

export function extractLoopCount(argsString: string): LoopExtraction | null {
	let loopCount: number | null = null;
	let loopFound = false;
	let fresh = false;
	let noConverge = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];
	const loopTokenRanges: Array<{ start: number; end: number }> = [];
	const tokens = getUnquotedTokens(argsString);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		if (token.token.startsWith("--loop=")) {
			loopTokenRanges.push({ start: token.start, end: token.end });
			const value = token.token.slice("--loop=".length);
			if (/^\d+$/.test(value)) {
				const parsed = parseInt(value, 10);
				if (parsed >= 1 && parsed <= 999 && !loopFound) {
					loopFound = true;
					loopCount = parsed;
				}
			}
			continue;
		}

		if (token.token === "--loop") {
			const next = tokens[i + 1];
			if (next && /^\s+$/.test(argsString.slice(token.end, next.start)) && /^\d+$/.test(next.token)) {
				loopTokenRanges.push({ start: token.start, end: token.end }, { start: next.start, end: next.end });
				const parsed = parseInt(next.token, 10);
				if (parsed >= 1 && parsed <= 999 && !loopFound) {
					loopFound = true;
					loopCount = parsed;
				}
				i++;
				continue;
			}

			loopTokenRanges.push({ start: token.start, end: token.end });
			if (!loopFound) {
				loopFound = true;
				loopCount = null;
			}
			continue;
		}

		if (token.token === "--fresh") {
			fresh = true;
			tokensToRemove.push({ start: token.start, end: token.end });
		}

		if (token.token === "--no-converge") {
			noConverge = true;
			tokensToRemove.push({ start: token.start, end: token.end });
		}
	}

	if (!loopFound) return null;

	const converge = !noConverge;
	return { args: removeTokenRanges(argsString, [...tokensToRemove, ...loopTokenRanges]), loopCount, fresh, converge };
}

export function extractLoopFlags(argsString: string): LoopFlags {
	let fresh = false;
	let noConverge = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	for (const token of getUnquotedTokens(argsString)) {
		if (token.token === "--fresh") {
			fresh = true;
			tokensToRemove.push({ start: token.start, end: token.end });
		}

		if (token.token === "--no-converge") {
			noConverge = true;
			tokensToRemove.push({ start: token.start, end: token.end });
		}
	}

	return { args: removeTokenRanges(argsString, tokensToRemove), fresh, converge: !noConverge };
}

function extractBooleanFlag(argsString: string, flag: string): { args: string; found: boolean } {
	let found = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	for (const token of getUnquotedTokens(argsString)) {
		if (token.token === flag) {
			found = true;
			tokensToRemove.push({ start: token.start, end: token.end });
		}
	}

	return { args: removeTokenRanges(argsString, tokensToRemove), found };
}

export function extractChainContextFlag(argsString: string): { args: string; chainContext: boolean } {
	const { args, found } = extractBooleanFlag(argsString, "--chain-context");
	return { args, chainContext: found };
}

export function extractWorktreeFlag(argsString: string): { args: string; worktree: boolean } {
	const { args, found } = extractBooleanFlag(argsString, "--worktree");
	return { args, worktree: found };
}

export function extractSubagentOverride(argsString: string): SubagentOverrideExtraction {
	let override: SubagentOverride | undefined;
	let cwdRaw: string | undefined;
	let modelRaw: string | undefined;
	let fork = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	for (const token of getUnquotedTokens(argsString)) {
		if (token.token === "--subagent") {
			tokensToRemove.push({ start: token.start, end: token.end });
			override = { enabled: true };
			continue;
		}

		if (token.token.startsWith("--subagent=") || token.token.startsWith("--subagent:")) {
			tokensToRemove.push({ start: token.start, end: token.end });
			const value = token.token.includes("=") ? token.token.slice("--subagent=".length) : token.token.slice("--subagent:".length);
			override = value ? { enabled: true, agent: value } : { enabled: true };
			continue;
		}

		if (token.token.startsWith("--cwd=")) {
			tokensToRemove.push({ start: token.start, end: token.end });
			const value = token.token.slice("--cwd=".length);
			cwdRaw = value || undefined;
			continue;
		}

		if (token.token.startsWith("--model=")) {
			tokensToRemove.push({ start: token.start, end: token.end });
			const value = token.token.slice("--model=".length);
			modelRaw = value || undefined;
			continue;
		}

		if (token.token === "--fork") {
			tokensToRemove.push({ start: token.start, end: token.end });
			fork = true;
			continue;
		}
	}

	if (fork && !override) override = { enabled: true };

	return {
		args: removeTokenRanges(argsString, tokensToRemove),
		...(override ? { override } : {}),
		...(cwdRaw !== undefined ? { cwd: cwdRaw } : {}),
		...(modelRaw !== undefined ? { model: modelRaw } : {}),
		...(fork ? { fork: true } : {}),
	};
}

function parseLineupOverrideSlots(
	raw: string,
	target: "workers" | "reviewers" | "finalApplier",
	mode: "replace" | "append",
	errors: string[],
): LineupOverrideAction | undefined {
	const label = `--${target === "finalApplier" ? "final-applier" : `${target}${mode === "append" ? "-append" : ""}`}`;
	if (!raw) {
		errors.push(`Invalid ${label}: expected ${target === "finalApplier" ? "a slot object or a one-element JSON array" : "a JSON array of slot objects"}.`);
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		errors.push(`Invalid ${label}: expected valid JSON (${message}).`);
		return undefined;
	}
	const entries = target === "finalApplier"
		? (Array.isArray(parsed)
			? parsed.length === 1
				? parsed
				: null
			: [parsed])
		: (Array.isArray(parsed) && parsed.length > 0 ? parsed : null);
	if (!entries) {
		errors.push(
			target === "finalApplier"
				? `Invalid ${label}: expected a slot object or a one-element JSON array.`
				: `Invalid ${label}: expected a non-empty JSON array.`,
		);
		return undefined;
	}

	const slots: LineupOverrideSlot[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push(`Invalid ${label}: slot ${i + 1} must be an object.`);
			return undefined;
		}
		const slot = entry as Record<string, unknown>;
		if (slot.agent !== undefined && slot.subagent !== undefined) {
			errors.push(`Invalid ${label}: slot ${i + 1} cannot combine "agent" and "subagent".`);
			return undefined;
		}

		let agent: string | undefined;
		if (typeof slot.agent === "string" && slot.agent.trim()) {
			agent = slot.agent.trim();
		} else if (slot.agent !== undefined) {
			errors.push(`Invalid ${label}: slot ${i + 1} requires a non-empty string "agent".`);
			return undefined;
		}

		if (!agent && slot.subagent !== undefined) {
			if (slot.subagent === true) {
				agent = target === "reviewers" ? "reviewer" : "delegate";
			} else if (typeof slot.subagent === "string" && slot.subagent.trim()) {
				agent = slot.subagent.trim();
			} else {
				errors.push(`Invalid ${label}: slot ${i + 1} requires "subagent" to be true or a non-empty string.`);
				return undefined;
			}
		}

		if (!agent) {
			errors.push(`Invalid ${label}: slot ${i + 1} requires "agent" or "subagent".`);
			return undefined;
		}
		const model = typeof slot.model === "string" && slot.model.trim() ? slot.model.trim() : undefined;
		const task = typeof slot.task === "string" && slot.task.trim() ? slot.task.trim() : undefined;
		const taskSuffix = typeof slot.taskSuffix === "string" && slot.taskSuffix.trim() ? slot.taskSuffix.trim() : undefined;
		if (target === "finalApplier" && slot.cwd !== undefined) {
			errors.push(`Invalid ${label}: slot ${i + 1} "cwd" is not supported.`);
			return undefined;
		}
		const cwd = typeof slot.cwd === "string" && slot.cwd.trim() ? slot.cwd.trim() : undefined;
		let count: number | undefined;
		if (slot.count !== undefined) {
			if (target === "finalApplier") {
				errors.push(`Invalid ${label}: slot ${i + 1} "count" is not supported.`);
				return undefined;
			}
			const rawCount = slot.count;
			if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1) {
				errors.push(`Invalid ${label}: slot ${i + 1} "count" must be an integer greater than or equal to 1.`);
				return undefined;
			}
			count = rawCount;
		}
		slots.push({
			agent,
			...(model ? { model } : {}),
			...(task ? { task } : {}),
			...(taskSuffix ? { taskSuffix } : {}),
			...(cwd ? { cwd } : {}),
			...(count !== undefined ? { count } : {}),
		});
	}

	return { target, mode, slots };
}

interface LineupOverrideFlagSpec {
	flag: string;
	target: "workers" | "reviewers" | "finalApplier";
	mode: "replace" | "append";
}

const LINEUP_OVERRIDE_FLAGS: LineupOverrideFlagSpec[] = [
	{ flag: "--workers-append=", target: "workers", mode: "append" },
	{ flag: "--reviewers-append=", target: "reviewers", mode: "append" },
	{ flag: "--workers=", target: "workers", mode: "replace" },
	{ flag: "--reviewers=", target: "reviewers", mode: "replace" },
	{ flag: "--final-applier=", target: "finalApplier", mode: "replace" },
];

function readQuotedValue(input: string, start: number): { value: string; end: number } | undefined {
	const quote = input[start];
	if (quote !== `"` && quote !== `'`) return undefined;

	let i = start + 1;
	while (i < input.length) {
		const char = input[i];
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (char === quote) {
			return {
				value: input.slice(start + 1, i),
				end: i + 1,
			};
		}
		i++;
	}

	return undefined;
}

function readBalancedValue(
	input: string,
	start: number,
	open: string,
	close: string,
): { value: string; end: number } | undefined {
	if (input[start] !== open) return undefined;

	let depth = 0;
	let inQuote: string | null = null;

	for (let i = start; i < input.length; i++) {
		const char = input[i];
		if (inQuote) {
			if (char === "\\") {
				i++;
				continue;
			}
			if (char === inQuote) inQuote = null;
			continue;
		}

		if (char === `"` || char === `'`) {
			inQuote = char;
			continue;
		}
		if (char === open) {
			depth++;
			continue;
		}
		if (char !== close) continue;

		depth--;
		if (depth === 0) {
			return {
				value: input.slice(start, i + 1),
				end: i + 1,
			};
		}
	}

	return undefined;
}

function readLineupOverrideValue(input: string, start: number): { value: string; end: number } {
	if (start >= input.length) return { value: "", end: start };

	const bracketed = readBalancedValue(input, start, "[", "]");
	if (bracketed) return bracketed;

	const braced = readBalancedValue(input, start, "{", "}");
	if (braced) return braced;

	const quoted = readQuotedValue(input, start);
	if (quoted) return quoted;

	let end = start;
	while (end < input.length && !/\s/.test(input[end])) end++;
	return {
		value: input.slice(start, end),
		end,
	};
}

function parseLineupOverrideToken(
	input: string,
	start: number,
): { target: "workers" | "reviewers" | "finalApplier"; mode: "replace" | "append"; raw: string; end: number } | undefined {
	for (const spec of LINEUP_OVERRIDE_FLAGS) {
		if (!input.startsWith(spec.flag, start)) continue;
		const valueStart = start + spec.flag.length;
		const parsedValue = readLineupOverrideValue(input, valueStart);
		return {
			target: spec.target,
			mode: spec.mode,
			raw: parsedValue.value,
			end: parsedValue.end,
		};
	}

	return undefined;
}

export function extractLineupOverrides(argsString: string): LineupOverrideExtraction {
	const actions: LineupOverrideAction[] = [];
	const errors: string[] = [];
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const token = parseLineupOverrideToken(argsString, i);
		if (token) {
			tokensToRemove.push({ start: i, end: token.end });
			const action = parseLineupOverrideSlots(token.raw, token.target, token.mode, errors);
			if (action) actions.push(action);
			i = token.end;
			continue;
		}

		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
	}

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	return { args: cleaned.trim(), actions, errors };
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}

		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	result = result.replace(/@\$/g, allArgs);

	return result;
}

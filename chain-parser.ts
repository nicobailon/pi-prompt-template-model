import { parseCommandArgs } from "./args.ts";

export interface ChainStep {
	name: string;
	args: string[];
	loopCount?: number | null;
	withContext?: boolean;
}

export interface ParallelChainStep {
	parallel: ChainStep[];
}

export type ChainStepOrParallel = ChainStep | ParallelChainStep;

export interface ParsedChainSteps {
	steps: ChainStepOrParallel[];
	sharedArgs: string[];
	invalidSegments: string[];
}

export interface ParsedChainDeclaration {
	steps: ChainStepOrParallel[];
	invalidSegments: string[];
}

interface SegmentToken {
	start: number;
	end: number;
	value: string;
	quoted: boolean;
}

function scanSegmentTokens(segment: string): SegmentToken[] {
	const tokens: SegmentToken[] = [];
	let i = 0;

	while (i < segment.length) {
		while (i < segment.length && /\s/.test(segment[i])) i++;
		if (i >= segment.length) break;

		const start = i;
		let inQuote: string | null = null;
		let value = "";
		let sawQuoted = false;
		let sawUnquoted = false;

		while (i < segment.length) {
			const char = segment[i];
			if (inQuote) {
				if (char === inQuote) {
					inQuote = null;
				} else {
					value += char;
				}
				i++;
				continue;
			}

			if (char === '"' || char === "'") {
				inQuote = char;
				sawQuoted = true;
				i++;
				continue;
			}
			if (/\s/.test(char)) break;

			value += char;
			sawUnquoted = true;
			i++;
		}

		tokens.push({
			start,
			end: i,
			value,
			quoted: sawQuoted && !sawUnquoted,
		});
	}

	return tokens;
}

function extractStepFlags(segment: string): { cleanedSegment: string; loopCount?: number | null; withContext: boolean } {
	const tokens = scanSegmentTokens(segment);
	const loopTokenRanges: Array<{ start: number; end: number }> = [];
	const withContextTokenRanges: Array<{ start: number; end: number }> = [];
	let loopCount: number | null | undefined;
	let withContext = false;

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.quoted) continue;

		if (token.value === "--with-context") {
			withContext = true;
			withContextTokenRanges.push({ start: token.start, end: token.end });
			continue;
		}

		if (token.value.startsWith("--loop=")) {
			loopTokenRanges.push({ start: token.start, end: token.end });
			const value = token.value.slice("--loop=".length);
			if (!/^\d+$/.test(value)) continue;
			const parsed = parseInt(value, 10);
			if (parsed >= 1 && parsed <= 999 && loopCount === undefined) {
				loopCount = parsed;
			}
			continue;
		}

		if (token.value === "--loop") {
			loopTokenRanges.push({ start: token.start, end: token.end });
			if (i + 1 < tokens.length) {
				const next = tokens[i + 1];
				if (!next.quoted && /^\d+$/.test(next.value)) {
					loopTokenRanges.push({ start: next.start, end: next.end });
					const parsed = parseInt(next.value, 10);
					if (parsed >= 1 && parsed <= 999 && loopCount === undefined) {
						loopCount = parsed;
					}
					i++;
					continue;
				}
			}
			if (loopCount === undefined) {
				loopCount = null;
			}
			continue;
		}
	}

	const loopRangesToRemove = loopCount !== undefined ? loopTokenRanges : [];
	if (loopRangesToRemove.length === 0 && withContextTokenRanges.length === 0) {
		return { cleanedSegment: segment, withContext: false };
	}

	const rangesToRemove = [...loopRangesToRemove, ...withContextTokenRanges].sort((a, b) => b.start - a.start);
	let cleanedSegment = segment;
	for (const { start, end } of rangesToRemove) {
		cleanedSegment = `${cleanedSegment.slice(0, start)}${cleanedSegment.slice(end)}`;
	}

	return { cleanedSegment: cleanedSegment.trim(), loopCount, withContext };
}

function splitByTopLevelSeparator(input: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inQuote: string | null = null;
	let parenDepth = 0;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			continue;
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--;
			continue;
		}

		if (parenDepth === 0 && i <= input.length - separator.length && input.startsWith(separator, i)) {
			parts.push(input.slice(start, i));
			start = i + separator.length;
			i += separator.length - 1;
		}
	}

	parts.push(input.slice(start));
	return parts;
}

function findMatchingParen(segment: string, openIndex: number): number {
	let inQuote: string | null = null;
	let depth = 0;

	for (let i = openIndex; i < segment.length; i++) {
		const char = segment[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "(") {
			depth++;
			continue;
		}
		if (char !== ")") continue;
		depth--;
		if (depth === 0) return i;
	}

	return -1;
}

function parseSingleStepSegment(segment: string): ChainStep | undefined {
	const { cleanedSegment, loopCount, withContext } = extractStepFlags(segment);
	const tokens = parseCommandArgs(cleanedSegment);
	if (tokens.length === 0) return undefined;
	return { name: tokens[0], args: tokens.slice(1), loopCount, ...(withContext ? { withContext: true } : {}) };
}

function parseParallelStepSegment(segment: string): ParallelChainStep | undefined {
	if (!/^parallel\s*\(/.test(segment)) return undefined;
	const openIndex = segment.indexOf("(");
	if (openIndex < 0) return undefined;

	const closeIndex = findMatchingParen(segment, openIndex);
	if (closeIndex < 0) return undefined;
	if (segment.slice(closeIndex + 1).trim().length > 0) return undefined;

	const inner = segment.slice(openIndex + 1, closeIndex).trim();
	if (!inner) return undefined;

	const parsedSteps: ChainStep[] = [];
	for (const rawEntry of splitByTopLevelSeparator(inner, ",")) {
		const entry = rawEntry.trim();
		if (!entry) return undefined;
		if (/^parallel\s*\(/.test(entry)) return undefined;
		const parsed = parseSingleStepSegment(entry);
		if (!parsed) return undefined;
		parsedSteps.push(parsed);
	}

	if (parsedSteps.length === 0) return undefined;
	return { parallel: parsedSteps };
}

function parseChainSegment(segment: string): ChainStepOrParallel | undefined {
	const parallelStep = parseParallelStepSegment(segment);
	if (parallelStep) return parallelStep;
	if (/^parallel\s*\(/.test(segment)) return undefined;
	return parseSingleStepSegment(segment);
}

export function parseChainSteps(args: string): ParsedChainSteps {
	const sharedArgsSplit = splitByTopLevelSeparator(args, " -- ");
	const templatesPart = sharedArgsSplit[0];
	const argsPart = sharedArgsSplit.length > 1 ? sharedArgsSplit.slice(1).join(" -- ") : "";

	const invalidSegments: string[] = [];
	const steps: ChainStepOrParallel[] = [];

	for (const rawSegment of splitByTopLevelSeparator(templatesPart, "->")) {
		const segment = rawSegment.trim();
		if (!segment) {
			invalidSegments.push(rawSegment);
			continue;
		}
		const parsedSegment = parseChainSegment(segment);
		if (!parsedSegment) {
			invalidSegments.push(segment);
			continue;
		}
		steps.push(parsedSegment);
	}

	return { steps, sharedArgs: parseCommandArgs(argsPart), invalidSegments };
}

export function parseChainDeclaration(chain: string): ParsedChainDeclaration {
	const invalidSegments: string[] = [];
	const steps: ChainStepOrParallel[] = [];

	for (const rawSegment of splitByTopLevelSeparator(chain, "->")) {
		const segment = rawSegment.trim();
		if (!segment) {
			invalidSegments.push(rawSegment);
			continue;
		}
		const parsedSegment = parseChainSegment(segment);
		if (!parsedSegment) {
			invalidSegments.push(segment);
			continue;
		}
		steps.push(parsedSegment);
	}

	return { steps, invalidSegments };
}

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	extractChainContextFlag,
	extractLineupOverrides,
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	extractWorktreeFlag,
	parseCommandArgs,
	substituteArgs,
	type LineupOverrideAction,
	type SubagentOverride,
} from "./args.ts";
import { parseChainSteps, parseChainDeclaration, type ChainStep, type ChainStepOrParallel, type ParallelChainStep } from "./chain-parser.ts";
import { generateBoomerangSummary, generateChainStepSummary, generateIterationSummary, didIterationMakeChanges, getIterationEntries, getLastAssistantText, wasIterationAborted } from "./loop-utils.ts";
import { selectModelCandidate } from "./model-selection.ts";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.ts";
import { preparePromptExecution, renderPromptForResolvedModel } from "./prompt-execution.ts";
import {
	buildPromptCommandDescription,
	expandCwdPath,
	loadPromptsWithModel,
	readSkillContent,
	resolveSkillPath,
	type DelegationLineupSlot,
	type PromptWithModel,
} from "./prompt-loader.ts";
import { renderSkillLoaded, type SkillLoadedDetails, type SkillLoadedSkillDetails } from "./skill-loaded-renderer.ts";
import { createToolManager } from "./tool-manager.ts";
import { executeSubagentPromptStep, type DelegatedPromptParallelResult } from "./subagent-step.ts";
import {
	DEFAULT_SUBAGENT_NAME,
	PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT,
	PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
	PROMPT_TEMPLATE_PROMPT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
	type DelegatedSkillBinding,
	type PromptTemplatePromptFinished,
	type PromptTemplatePromptStarted,
	type PromptTemplatePromptStatus,
} from "./subagent-runtime.ts";
import { renderDelegatedSubagentResult } from "./subagent-renderer.ts";
import {
	PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
	PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
	buildDeterministicPreamble,
	runDeterministicStep,
	shouldHandoffToLlm,
} from "./deterministic-step.ts";
import { renderDeterministicCompletion, renderDeterministicResult } from "./deterministic-renderer.ts";

interface LoopState {
	currentIteration: number;
	totalIterations: number | null;
	rotationLabel?: string;
}

interface FreshCollapse {
	targetId: string;
	task: string;
	iteration: number;
	totalIterations: number | null;
}

interface BoomerangCollapse {
	targetId: string;
	task: string;
	previousSummaries: string[];
}

interface PendingSkillMessage {
	customType: "skill-loaded";
	content: string;
	display: true;
	details: SkillLoadedDetails;
}

type SkillMessageResolution =
	| { kind: "none" }
	| { kind: "ready"; message: PendingSkillMessage }
	| { kind: "error"; error: string };

interface ExecutionErrorState {
	hasError: boolean;
	error: unknown;
}

interface PromptStepResult {
	changed: boolean;
	text?: string;
	status?: PromptTemplatePromptStatus;
}

interface PromptTurnRestore {
	originalModel: Model<any> | undefined;
	originalThinking: ThinkingLevel | undefined;
}

function emitPromptLifecycleEvent(
	pi: ExtensionAPI,
	event: typeof PROMPT_TEMPLATE_PROMPT_STARTED_EVENT | typeof PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT,
	payload: PromptTemplatePromptStarted | PromptTemplatePromptFinished,
): void {
	try {
		pi.events.emit(event, payload);
	} catch {
		// Prompt lifecycle observers must not affect prompt execution.
	}
}

const DEFAULT_COMPARE_REVIEWER_TASK = [
	"Review the worker variants and produce findings only.",
	"Required output:",
	"1. Summarize concrete strengths with patch/diff evidence, including worktree change summaries when present.",
	"2. Call out concrete correctness risks and regression risks.",
	"3. Extract cherry-pick ideas from non-winning variants.",
	"4. Do not rank variants or select a winner.",
	"5. Do not include manual apply commands.",
].join("\n");

const DEFAULT_COMPARE_FINAL_APPLIER_TASK = [
	"Apply the final implementation directly in the current repo.",
	"Required output:",
	"1. Pick the best single variant or synthesize/cherry-pick across variants.",
	"2. Apply changes directly on the current branch.",
	"3. Keep edits minimal and focused on the implementation task.",
	"4. Run obvious relevant verification when practical.",
	"5. Report changed files and verification commands run.",
].join("\n");

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let chainPrompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkillMessage: PendingSkillMessage | undefined;
	let runtimeModel: Model<any> | undefined;
	let chainActive = false;
	let loopState: LoopState | null = null;
	let freshCollapse: FreshCollapse | null = null;
	let boomerangCollapse: BoomerangCollapse | null = null;
	let accumulatedSummaries: string[] = [];
	let lastDiagnostics = "";
	let storedCommandCtx: ExtensionCommandContext | null = null;
	const UNLIMITED_LOOP_CAP = 999;

	const toolManager = createToolManager(pi, {
		isActive: () => !!(loopState || chainActive),
		getStoredCtx: () => storedCommandCtx,
		setStoredCtx: (ctx) => {
			storedCommandCtx = ctx;
		},
		executeCommand: executeToolCommand,
	});

	function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
		if (!a || !b) return a === b;
		return a.provider === b.provider && a.id === b.id;
	}

	function getCurrentModel(ctx: Pick<ExtensionContext, "model">): Model<any> | undefined {
		return runtimeModel ?? ctx.model;
	}

	pi.registerMessageRenderer<SkillLoadedDetails>("skill-loaded", renderSkillLoaded);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, renderDelegatedSubagentResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE, renderDeterministicResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE, renderDeterministicCompletion);

	function registerPromptCommand(name: string) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompts.get(name)!),
			handler: async (args, ctx) => {
				await runPromptCommand(name, args, ctx);
			},
		});
	}

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const promptLoaderOptions = { includeProjectPrompts: ctx ? ctx.isProjectTrusted() : true };
		const result = loadPromptsWithModel(cwd, false, promptLoaderOptions);
		const chainResult = loadPromptsWithModel(cwd, true, promptLoaderOptions);
		prompts = result.prompts;
		chainPrompts = chainResult.prompts;

		for (const name of prompts.keys()) {
			registerPromptCommand(name);
		}

		const summary = summarizePromptDiagnostics(result.diagnostics);
		const fingerprint = diagnosticsFingerprint(result.diagnostics);
		if (summary && fingerprint !== lastDiagnostics) {
			notify(ctx, summary, "warning");
		}
		lastDiagnostics = fingerprint;
	}

	function consumePendingSkillMessage() {
		if (!pendingSkillMessage) return undefined;
		const message = pendingSkillMessage;
		pendingSkillMessage = undefined;
		return message;
	}

	function normalizeSkillName(skillName: string): string {
		return skillName.startsWith("skill:") ? skillName.slice("skill:".length) : skillName;
	}

	function isPathResolvableSkillName(skillName: string): boolean {
		if (skillName === "." || skillName === "..") return false;
		if (skillName.includes("/")) return false;
		if (skillName.includes("\\")) return false;
		return true;
	}

	function resolveRegisteredSkillPath(skillName: string): string | undefined {
		const normalizedSkillName = normalizeSkillName(skillName);
		if (!normalizedSkillName) return undefined;
		const candidates = new Set([normalizedSkillName, `skill:${normalizedSkillName}`]);

		for (const command of pi.getCommands()) {
			if (command.source !== "skill") continue;
			const sourceInfo = "sourceInfo" in command
				? (command as { sourceInfo?: { path?: string } }).sourceInfo
				: undefined;
			if (!sourceInfo?.path) continue;
			if (!candidates.has(command.name)) continue;
			return sourceInfo.path;
		}

		return undefined;
	}

	function resolveSkills(skillNames: string[] | undefined, cwd: string, ctx?: ExtensionContext):
		| { kind: "none" }
		| { kind: "ready"; skills: SkillLoadedSkillDetails[] }
		| { kind: "error"; error: string } {
		if (!skillNames?.length) return { kind: "none" };

		const resolvedSkills: SkillLoadedSkillDetails[] = [];
		for (const skillName of skillNames) {
			const normalizedSkillName = normalizeSkillName(skillName);
			if (!normalizedSkillName || !isPathResolvableSkillName(normalizedSkillName)) {
				return { kind: "error", error: `Skill "${skillName}" not found` };
			}

			const skillPath =
				resolveRegisteredSkillPath(skillName) ??
				resolveSkillPath(normalizedSkillName, cwd, { includeProjectSkills: ctx ? ctx.isProjectTrusted() : true });
			if (!skillPath) {
				return { kind: "error", error: `Skill "${skillName}" not found` };
			}

			try {
				resolvedSkills.push({
					skillName: normalizedSkillName,
					skillContent: readSkillContent(skillPath),
					skillPath,
				});
			} catch (error) {
				return {
					kind: "error",
					error: `Failed to read skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		return { kind: "ready", skills: resolvedSkills };
	}

	function resolveSkillMessage(skillNames: string[] | undefined, cwd: string, ctx?: ExtensionContext): SkillMessageResolution {
		const resolution = resolveSkills(skillNames, cwd, ctx);
		if (resolution.kind !== "ready") return resolution;

		const primarySkill = resolution.skills[0]!;
		return {
			kind: "ready",
			message: {
				customType: "skill-loaded",
				content: resolution.skills
					.map((skill) => `<skill name="${skill.skillName}">\n${skill.skillContent}\n</skill>`)
					.join("\n\n"),
				display: true,
				details: {
					...primarySkill,
					...(resolution.skills.length > 1 ? { skills: resolution.skills } : {}),
				},
			},
		};
	}

	function resolveDelegatedSkillBindings(skillNames: string[], cwd: string, ctx: ExtensionContext): DelegatedSkillBinding[] {
		const resolution = resolveSkills(skillNames, cwd, ctx);
		if (resolution.kind === "error") throw new Error(resolution.error);
		if (resolution.kind === "none") return [];
		return resolution.skills.map((skill) => ({ name: skill.skillName, path: skill.skillPath }));
	}

	async function waitForTurnStart(ctx: ExtensionContext) {
		while (ctx.isIdle()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function shouldDelegatePrompt(prompt: PromptWithModel, override?: SubagentOverride): boolean {
		return prompt.subagent !== undefined || override?.enabled === true;
	}

	function isParallelChainStep(step: ChainStepOrParallel): step is ParallelChainStep {
		return "parallel" in step;
	}

	async function executePromptStep(
		prompt: PromptWithModel,
		args: string[],
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		override?: SubagentOverride,
		inheritedModel?: Model<any>,
		taskPreamble?: string,
		loopContext?: string,
		promptTurnRestore?: PromptTurnRestore,
	): Promise<PromptStepResult | "aborted"> {
		let deterministicPreamble: string | undefined;
		if (prompt.deterministic) {
			try {
				const deterministicResult = await runDeterministicStep(prompt, prompt.deterministic, ctx.cwd);
				const deterministicPreambleText = buildDeterministicPreamble(deterministicResult);
				pi.sendMessage({
					customType: PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
					content: deterministicPreambleText,
					display: true,
					details: deterministicResult,
				});
				if (!shouldHandoffToLlm(prompt.deterministic, deterministicResult)) {
					pi.sendMessage({
						customType: PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
						content: `[Deterministic complete: ${prompt.name}]`,
						display: true,
						details: {
							promptName: prompt.name,
							exitCode: deterministicResult.exitCode,
							timedOut: deterministicResult.timedOut,
							status: deterministicResult.exitCode === 0 ? "succeeded" : "failed",
						},
					});
					return { changed: false, status: deterministicResult.exitCode === 0 ? "completed" : "failed" };
				}
				deterministicPreamble = deterministicPreambleText;
			} catch (error) {
				notify(ctx, `Deterministic step failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "aborted";
			}
		}

		const combinedTaskPreamble = [taskPreamble, deterministicPreamble].filter(Boolean).join("\n\n");

		if (shouldDelegatePrompt(prompt, override)) {
			try {
				const delegated =
					prompt.parallel && prompt.parallel > 1
						? await executeSubagentPromptStep({
							pi,
							ctx,
							resolveSkillBindings: (skillNames, cwd) => resolveDelegatedSkillBindings(skillNames, cwd, ctx),
							currentModel,
							override,
							signal: ctx.signal,
							inheritedModel,
							taskPreamble: combinedTaskPreamble || undefined,
							parallel: Array.from({ length: prompt.parallel }, (_, index) => ({
								prompt,
								args,
								taskPrefix: `[Parallel subagent ${index + 1}/${prompt.parallel}]`,
							})),
							worktree: prompt.worktree === true,
						})
						: await executeSubagentPromptStep({
							pi,
							prompt,
							args,
							ctx,
							resolveSkillBindings: (skillNames, cwd) => resolveDelegatedSkillBindings(skillNames, cwd, ctx),
							currentModel,
							override,
							signal: ctx.signal,
							inheritedModel,
							taskPreamble: combinedTaskPreamble || undefined,
						});
				if (!delegated) {
					notify(ctx, `Prompt \`${prompt.name}\` is not configured for delegated execution.`, "error");
					return "aborted";
				}
				return { changed: delegated.changed, text: delegated.text };
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return { changed: false, status: ctx.signal?.aborted ? "cancelled" : "failed" };
			}
		}

		const prepared =
			inheritedModel === undefined
				? await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { scopedModels: ctx.scopedModels })
				: await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { inheritedModel, scopedModels: ctx.scopedModels });
		if (!prepared) {
			notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
			return "aborted";
		}
		if ("message" in prepared) {
			if (prepared.warning) notify(ctx, prepared.warning, "warning");
			notify(ctx, prepared.message, "error");
			return "aborted";
		}
		if (prepared.warning) {
			notify(ctx, prepared.warning, "warning");
		}

		const skillResolution = resolveSkillMessage(prompt.skill, ctx.cwd, ctx);
		if (skillResolution.kind === "error") {
			notify(ctx, skillResolution.error, "error");
			return "aborted";
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				return "aborted";
			}
			runtimeModel = prepared.selectedModel.model;
		}

		if (prompt.thinking) {
			pi.setThinkingLevel(prompt.thinking);
		}
		pendingSkillMessage = skillResolution.kind === "ready" ? skillResolution.message : undefined;

		if (promptTurnRestore) {
			const currentModel = getCurrentModel(ctx);
			if (promptTurnRestore.originalModel && currentModel && !sameModel(promptTurnRestore.originalModel, currentModel)) {
				previousModel = promptTurnRestore.originalModel;
				previousThinking = promptTurnRestore.originalThinking;
			}
			if (prompt.thinking && previousThinking === undefined && prompt.thinking !== promptTurnRestore.originalThinking) {
				previousThinking = promptTurnRestore.originalThinking;
			}
		}

		const startId = ctx.sessionManager.getLeafId();
		const effectiveContent = combinedTaskPreamble
			? `${combinedTaskPreamble}\n\n${prepared.content}`
			: prepared.content;
		const content = loopContext ? `[${loopContext}]\n\n${effectiveContent}` : effectiveContent;
		pi.sendUserMessage(content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();

		const entries = getIterationEntries(ctx, startId);
		if (wasIterationAborted(entries)) return "aborted";
		return { changed: didIterationMakeChanges(entries) };
	}

	async function restoreSessionState(
		ctx: ExtensionContext,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel?: Model<any>,
		currentThinking?: ThinkingLevel,
	) {
		const restoredParts: string[] = [];
		const shouldRestoreThinking =
			originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

		if (originalModel && !sameModel(originalModel, currentModel)) {
			const restoredModel = await pi.setModel(originalModel);
			if (restoredModel) {
				runtimeModel = originalModel;
				restoredParts.push(originalModel.id);
			} else {
				notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
			}
		}
		if (shouldRestoreThinking) {
			restoredParts.push(`thinking:${originalThinking}`);
			pi.setThinkingLevel(originalThinking);
		}
		if (restoredParts.length > 0) {
			notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
		}
	}

	async function restoreAfterExecution(
		ctx: ExtensionContext,
		shouldRestore: boolean,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel: Model<any> | undefined,
		currentThinking: ThinkingLevel | undefined,
		errorState: ExecutionErrorState,
		phase: "loop" | "chain",
	): Promise<ExecutionErrorState> {
		if (!shouldRestore) return errorState;

		try {
			await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
		} catch (error) {
			if (errorState.hasError) {
				notify(
					ctx,
					`Failed to restore session state after ${phase} error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return errorState;
			}
			return { hasError: true, error };
		}

		return errorState;
	}

	function notifyLoopCompletion(
		ctx: ExtensionContext,
		completedIterations: number,
		totalIterations: number | null,
		effectiveMax: number,
		converged: boolean,
		requireMultipleIterations: boolean,
	) {
		if (converged) {
			const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
			notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			return;
		}

		if (completedIterations === 0) return;
		if (requireMultipleIterations && effectiveMax <= 1) return;

		if (totalIterations !== null) {
			notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
			return;
		}
		if (completedIterations === effectiveMax) {
			notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
			return;
		}
		notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
	}

	function updateLoopStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (loopState) {
			const suffix = loopState.rotationLabel ? ` · ${loopState.rotationLabel}` : "";
			const label =
				loopState.totalIterations !== null
					? `loop ${loopState.currentIteration}/${loopState.totalIterations}${suffix}`
					: `loop ${loopState.currentIteration}${suffix}`;
			ctx.ui.setStatus("prompt-loop", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("prompt-loop", undefined);
		}
	}

	async function executeToolCommand(command: string, ctx: ExtensionCommandContext) {
		const stripped = command.startsWith("/") ? command.slice(1) : command;
		const spaceIdx = stripped.indexOf(" ");
		const name = spaceIdx >= 0 ? stripped.slice(0, spaceIdx) : stripped;
		const args = spaceIdx >= 0 ? stripped.slice(spaceIdx + 1) : "";

		if (name === "chain-prompts") {
			await runChainCommand(args, ctx);
		} else {
			await runPromptCommand(name, args, ctx);
		}
	}

	function cloneLineup(slots: DelegationLineupSlot[] | undefined): DelegationLineupSlot[] | undefined {
		return slots?.map((slot) => ({ ...slot }));
	}

	function expandLineupCounts(slots: DelegationLineupSlot[]): DelegationLineupSlot[] {
		const expanded: DelegationLineupSlot[] = [];
		for (const slot of slots) {
			const { count, ...concreteSlot } = slot;
			for (let index = 0; index < (count ?? 1); index++) {
				expanded.push({ ...concreteSlot });
			}
		}
		return expanded;
	}

	function applyLineupActions(
		defaultSlots: DelegationLineupSlot[] | undefined,
		actions: LineupOverrideAction[],
		target: "workers" | "reviewers",
	): DelegationLineupSlot[] | undefined {
		let lineup = cloneLineup(defaultSlots);
		for (const action of actions) {
			if (action.target !== target) continue;
			const incoming = action.slots.map((slot) => ({ ...slot }));
			lineup = action.mode === "replace" ? incoming : [...(lineup ?? []), ...incoming];
		}
		return lineup;
	}

	function applyFinalApplierAction(
		defaultSlot: DelegationLineupSlot | undefined,
		actions: LineupOverrideAction[],
	): DelegationLineupSlot | undefined {
		let slot = defaultSlot ? { ...defaultSlot } : undefined;
		for (const action of actions) {
			if (action.target !== "finalApplier") continue;
			slot = action.slots[0] ? { ...action.slots[0] } : undefined;
		}
		return slot;
	}

	async function resolveCompareBaseModel(
		prompt: PromptWithModel,
		currentModel: Model<any> | undefined,
		ctx: ExtensionCommandContext,
		modelOverride?: string,
	): Promise<Model<any> | undefined> {
		const requestedModels = modelOverride ? [modelOverride] : prompt.models;
		if (requestedModels.length > 0) {
			const selected = await selectModelCandidate(requestedModels, currentModel, ctx.modelRegistry, { scopedModels: ctx.scopedModels });
			if (!selected) {
				notify(ctx, `No available model from: ${requestedModels.join(", ")}`, "error");
				return undefined;
			}
			return selected.model;
		}
		if (currentModel) return currentModel;
		notify(ctx, `Prompt \`${prompt.name}\` requires an active model or a runtime --model override.`, "error");
		return undefined;
	}

	function resolveCompareCwd(raw: string, ctx: ExtensionCommandContext): string {
		return expandCwdPath(raw) ?? resolvePath(ctx.cwd, raw);
	}

	function normalizeLineupCwds(
		slots: DelegationLineupSlot[],
		defaultCwd: string,
		ctx: ExtensionCommandContext,
	): DelegationLineupSlot[] | undefined {
		const normalized: DelegationLineupSlot[] = [];
		for (const slot of slots) {
			const slotCwd = slot.cwd ? resolveCompareCwd(slot.cwd, ctx) : defaultCwd;
			if (!existsSync(slotCwd)) {
				notify(ctx, `cwd directory does not exist: ${slotCwd}`, "error");
				return undefined;
			}
			normalized.push({
				...slot,
				cwd: slotCwd,
			});
		}
		return normalized;
	}

	function formatCompareSlotLabel(slot: DelegationLineupSlot, fallbackAgent: string): string {
		return slot.model ? `${fallbackAgent}, ${slot.model}` : fallbackAgent;
	}

	function renderComparePhaseResults(
		label: string,
		entries: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>,
	): string {
		return entries
			.map(({ index, slot, result }) => {
				const body = result.text || "(no assistant text)";
				return `=== ${label} ${index + 1} (${formatCompareSlotLabel(slot, result.agent)}) ===\n${body}`;
			})
			.join("\n\n");
	}

	function formatPhaseFailureSummary(
		label: string,
		entries: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>,
	): string | undefined {
		if (entries.length === 0) return undefined;
		return [
			`[${label} failures]`,
			...entries.map(({ index, slot, result }) =>
				`- ${label} ${index + 1} (${formatCompareSlotLabel(slot, result.agent)}): ${result.errorText || "unknown delegated error"}`,
			),
		].join("\n");
	}

	function extractSuccessfulWorktreeChanges(aggregateText: string | undefined, successfulIndexes: number[]): string | undefined {
		if (!aggregateText) return undefined;
		const marker = "=== Worktree Changes ===";
		const markerIndex = aggregateText.indexOf(marker);
		if (markerIndex < 0) return undefined;
		const worktreeText = aggregateText.slice(markerIndex + marker.length).trim();
		if (!worktreeText) return undefined;
		const successfulTaskNumbers = new Set(successfulIndexes.map((index) => index + 1));
		const sections = worktreeText
			.split(/\n(?=--- Task \d+ \()/)
			.map((section) => section.trim())
			.filter(Boolean)
			.filter((section) => {
				const match = section.match(/^--- Task (\d+) \(/);
				return match ? successfulTaskNumbers.has(parseInt(match[1]!, 10)) : false;
			});
		if (sections.length === 0) return undefined;
		return `${marker}\n\n${sections.join("\n\n")}`;
	}

	function buildReviewerPreamble(sharedTask: string, workerAggregation: string, workerFailureSummary?: string): string {
		return [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			workerAggregation,
			...(workerFailureSummary ? ["", workerFailureSummary] : []),
		].join("\n");
	}

	function buildFinalApplierPreamble(
		sharedTask: string,
		workerAggregation: string,
		workerFailureSummary?: string,
		reviewerAggregation?: string,
		reviewerFailureSummary?: string,
	): string {
		return [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			workerAggregation,
			...(workerFailureSummary ? ["", workerFailureSummary] : []),
			"",
			"[Reviewer findings]",
			reviewerAggregation ?? "All reviewer runs failed. Synthesize directly from the worker variants.",
			...(reviewerFailureSummary ? ["", reviewerFailureSummary] : []),
			"",
			"[Final apply instructions]",
			"Pick one winner or synthesize/cherry-pick from multiple variants, apply the final patch directly in the current repo, keep edits minimal, run obvious relevant verification when practical, and report changed files plus verification run.",
		].join("\n");
	}

	function buildLineupSlotTask(
		baseTask: string,
		slot: DelegationLineupSlot,
		taskArgs: string[],
	): string {
		const effectiveBaseTask = slot.task ? substituteArgs(slot.task, taskArgs) : baseTask;
		if (!slot.taskSuffix) return effectiveBaseTask;
		return `${effectiveBaseTask}\n\n${substituteArgs(slot.taskSuffix, taskArgs)}`;
	}

	function buildComparePrompt(
		base: PromptWithModel,
		options: {
			name: string;
			agent: string;
			task: string;
			model?: string;
			cwd: string;
			inheritContext?: boolean;
		},
	): PromptWithModel {
		return {
			...base,
			name: options.name,
			content: options.task,
			models: options.model ? [options.model] : [],
			chain: undefined,
			chainContext: undefined,
			parallel: undefined,
			worktree: undefined,
			subagent: options.agent,
			inheritContext: options.inheritContext ? true : undefined,
			cwd: options.cwd,
			workers: undefined,
			reviewers: undefined,
			finalApplier: undefined,
		};
	}

	async function runComparePrompt(
		name: string,
		prompt: PromptWithModel,
		args: string,
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		runtime: { cwd?: string; model?: string; subagentOverride?: SubagentOverride; fork?: boolean },
	) {
		if (runtime.subagentOverride) {
			notify(ctx, `--subagent is not supported for compare prompts (ignored)`, "warning");
		}
		if (runtime.fork) {
			notify(ctx, `--fork is not supported for compare prompts (ignored)`, "warning");
		}

		const lineupExtraction = extractLineupOverrides(args);
		if (lineupExtraction.errors.length > 0) {
			for (const error of lineupExtraction.errors) {
				notify(ctx, error, "error");
			}
			return;
		}

		let taskArgs = parseCommandArgs(lineupExtraction.args);
		let compareCwd = runtime.cwd ?? prompt.cwd ?? ctx.cwd;
		if (name === "parallel-patch-compare-at-path") {
			if (taskArgs.length === 0) {
				notify(ctx, "parallel-patch-compare-at-path requires a repo path as the first argument.", "error");
				return;
			}
			if (runtime.cwd) {
				notify(ctx, "--cwd is ignored for parallel-patch-compare-at-path (using first positional path).", "warning");
			}
			compareCwd = resolveCompareCwd(taskArgs[0]!, ctx);
			taskArgs = taskArgs.slice(1);
			if (taskArgs.length === 0) {
				notify(ctx, "parallel-patch-compare-at-path requires an implementation task after the repo path.", "error");
				return;
			}
		}

		if (!existsSync(compareCwd)) {
			notify(ctx, `cwd directory does not exist: ${compareCwd}`, "error");
			return;
		}

		const baseModel = await resolveCompareBaseModel(prompt, currentModel, ctx, runtime.model);
		if (!baseModel) return;

		const rendered = renderPromptForResolvedModel(prompt, taskArgs, baseModel);
		if (rendered.warning) notify(ctx, rendered.warning, "warning");
		if (rendered.empty || !rendered.content) {
			notify(ctx, rendered.empty ?? `Prompt \`${prompt.name}\` rendered to an empty message.`, "error");
			return;
		}
		const sharedTask = rendered.content;

		const requestedWorkers = applyLineupActions(prompt.workers, lineupExtraction.actions, "workers") ?? [];
		const requestedReviewers = applyLineupActions(prompt.reviewers, lineupExtraction.actions, "reviewers") ?? [];
		const requestedFinalApplier = applyFinalApplierAction(prompt.finalApplier, lineupExtraction.actions);
		if (requestedFinalApplier && prompt.worktree !== true) {
			notify(ctx, "Compare prompts with finalApplier require worktree: true.", "error");
			return;
		}

		const workerSlots = expandLineupCounts(
			requestedWorkers.length > 0
				? requestedWorkers
				: [{ agent: DEFAULT_SUBAGENT_NAME }],
		);
		const reviewerSlots = expandLineupCounts(
			requestedReviewers.length > 0
				? requestedReviewers
				: [{ agent: "reviewer" }],
		);

		const normalizedWorkers = normalizeLineupCwds(workerSlots, compareCwd, ctx);
		if (!normalizedWorkers) return;
		const normalizedReviewers = normalizeLineupCwds(reviewerSlots, compareCwd, ctx);
		if (!normalizedReviewers) return;
		const normalizedFinalApplier = requestedFinalApplier
			? {
				...requestedFinalApplier,
				cwd: compareCwd,
			}
			: undefined;

		if (prompt.worktree === true) {
			const uniqueWorkerCwds = new Set(normalizedWorkers.map((slot) => slot.cwd));
			if (uniqueWorkerCwds.size > 1) {
				notify(ctx, "worktree compare runs require all worker slots to use the same cwd.", "error");
				return;
			}
		}

		try {
			const workerResult = await executeSubagentPromptStep({
				pi,
				ctx,
				resolveSkillBindings: (skillNames, cwd) => resolveDelegatedSkillBindings(skillNames, cwd, ctx),
				currentModel: baseModel,
				signal: ctx.signal,
				worktree: prompt.worktree === true,
				allowPartialFailures: true,
				parallel: normalizedWorkers.map((slot, index) => ({
					prompt: buildComparePrompt(prompt, {
						name: `${prompt.name}-worker-${index + 1}`,
						agent: slot.agent,
						task: buildLineupSlotTask(sharedTask, slot, taskArgs),
						model: slot.model,
						cwd: slot.cwd!,
						inheritContext: true,
					}),
					args: [],
				})),
			});
			const workerPairs = (workerResult?.parallelResults ?? []).map((result, index) => ({
				index,
				slot: normalizedWorkers[index]!,
				result,
			}));
			if (workerPairs.length === 0) return;
			const successfulWorkers = workerPairs.filter((entry) => !entry.result.isError);
			const failedWorkers = workerPairs.filter((entry) => entry.result.isError);
			if (successfulWorkers.length === 0) {
				notify(ctx, `Compare worker phase failed: all worker slots failed.`, "error");
				return;
			}
			const successfulWorkerText = [
				renderComparePhaseResults("Worker", successfulWorkers),
				extractSuccessfulWorktreeChanges(workerResult.text, successfulWorkers.map((entry) => entry.index)),
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n");
			const workerFailureSummary = formatPhaseFailureSummary("Worker", failedWorkers);

			const reviewerPreamble = buildReviewerPreamble(sharedTask, successfulWorkerText, workerFailureSummary);
			const reviewerResult = await executeSubagentPromptStep({
				pi,
				ctx,
				resolveSkillBindings: (skillNames, cwd) => resolveDelegatedSkillBindings(skillNames, cwd, ctx),
				currentModel: baseModel,
				signal: ctx.signal,
				taskPreamble: reviewerPreamble,
				allowPartialFailures: true,
				parallel: normalizedReviewers.map((slot, index) => ({
					prompt: buildComparePrompt(prompt, {
						name: `${prompt.name}-reviewer-${index + 1}`,
						agent: slot.agent,
						task: buildLineupSlotTask(DEFAULT_COMPARE_REVIEWER_TASK, slot, taskArgs),
						model: slot.model,
						cwd: slot.cwd!,
						inheritContext: false,
					}),
					args: [],
				})),
			});
			const reviewerPairs = (reviewerResult?.parallelResults ?? []).map((result, index) => ({
				index,
				slot: normalizedReviewers[index]!,
				result,
			}));
			if (reviewerPairs.length === 0) return;
			const successfulReviewers = reviewerPairs.filter((entry) => !entry.result.isError);
			const failedReviewers = reviewerPairs.filter((entry) => entry.result.isError);
			const successfulReviewerText = successfulReviewers.length > 0
				? renderComparePhaseResults("Reviewer", successfulReviewers)
				: undefined;
			const reviewerFailureSummary = formatPhaseFailureSummary("Reviewer", failedReviewers);

			if (!normalizedFinalApplier) {
				if (!successfulReviewerText) {
					notify(ctx, `Compare reviewer phase failed: all reviewer slots failed.`, "error");
					return;
				}
				const finalText = reviewerFailureSummary
					? `${successfulReviewerText}\n\n${reviewerFailureSummary}`
					: successfulReviewerText;
				pi.sendUserMessage(`[Compare review complete: ${name}]\n\n${finalText}`);
				await waitForTurnStart(ctx);
				await ctx.waitForIdle();
				return;
			}

			const finalResult = await executeSubagentPromptStep({
				pi,
				ctx,
				resolveSkillBindings: (skillNames, cwd) => resolveDelegatedSkillBindings(skillNames, cwd, ctx),
				currentModel: baseModel,
				signal: ctx.signal,
				taskPreamble: buildFinalApplierPreamble(
					sharedTask,
					successfulWorkerText,
					workerFailureSummary,
					successfulReviewerText,
					reviewerFailureSummary,
				),
				prompt: buildComparePrompt(prompt, {
					name: `${prompt.name}-final-applier`,
					agent: normalizedFinalApplier.agent,
					task: buildLineupSlotTask(DEFAULT_COMPARE_FINAL_APPLIER_TASK, normalizedFinalApplier, taskArgs),
					model: normalizedFinalApplier.model,
					cwd: compareCwd,
					inheritContext: false,
				}),
				args: [],
			});
			if (!finalResult?.text) return;
			pi.sendUserMessage(`[Compare apply complete: ${name}]\n\n${finalResult.text}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function collapseBoomerangPrompt(
		ctx: ExtensionContext,
		name: string,
		targetId: string | null,
		previousSummaries: string[] = [],
	) {
		if (!targetId) {
			notify(ctx, `Cannot boomerang prompt \`${name}\`: no session entry to return to.`, "warning");
			return;
		}

		boomerangCollapse = { targetId, task: name, previousSummaries };
		try {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = true;
			const result = await ctx.navigateTree(targetId, { summarize: true });
			if (result.cancelled) notify(ctx, `Boomerang cancelled for prompt \`${name}\``, "warning");
		} finally {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = false;
			boomerangCollapse = null;
		}
	}

	async function runPromptLoop(
		name: string,
		cleanedArgs: string,
		totalIterations: number | null,
		freshFlag: boolean,
		converge: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		promptOverrides?: Partial<Pick<PromptWithModel, "models" | "inheritContext">>,
	) {
		refreshPrompts(ctx.cwd, ctx);
		const initialPrompt = prompts.get(name);
		if (!initialPrompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		let currentModel = savedModel;
		let currentThinking = savedThinking;
		const shouldRestore = initialPrompt.restore;
		const useFresh = freshFlag || initialPrompt.fresh === true;
		const shouldBoomerang = initialPrompt.boomerang === true;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge && initialPrompt.converge !== false;
		const anchorId = useFresh || shouldBoomerang ? ctx.sessionManager.getLeafId() : null;

		loopState = { currentIteration: 1, totalIterations };
		accumulatedSummaries = [];
		updateLoopStatus(ctx);
		let completedIterations = 0;
		let converged = false;
		let loopErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		let lastDelegatedText: string | undefined;
		let loopAborted = false;
		let boomerangPreviousSummaries: string[] = [];
		let runStatus: PromptTemplatePromptStatus = "completed";

		try {
			for (let i = 0; i < effectiveMax; i++) {
				loopState.currentIteration = i + 1;
				const iterationLabel = totalIterations !== null ? `${i + 1}/${totalIterations}` : `${i + 1}`;

				refreshPrompts(ctx.cwd, ctx);
				const prompt = prompts.get(name);
				if (!prompt) {
					notify(ctx, `Prompt "${name}" no longer exists`, "error");
					loopAborted = true;
					break;
				}
				const effectivePrompt = { ...prompt, ...(cwdOverride ? { cwd: cwdOverride } : {}), ...promptOverrides };
				let iterationPrompt = effectivePrompt;
				loopState!.rotationLabel = undefined;
				if (effectivePrompt.rotate && effectivePrompt.models.length > 1) {
					const rotationIndex = i % effectivePrompt.models.length;
					const rotatedThinking = effectivePrompt.thinkingLevels
						? effectivePrompt.thinkingLevels[rotationIndex]
						: effectivePrompt.thinking;
					iterationPrompt = {
						...effectivePrompt,
						models: [effectivePrompt.models[rotationIndex]],
						thinking: rotatedThinking,
					};
					const shortModel = effectivePrompt.models[rotationIndex].split("/").pop() || effectivePrompt.models[rotationIndex];
					const thinkingLabel = rotatedThinking ? ` ${rotatedThinking}` : "";
					loopState!.rotationLabel = `${shortModel}${thinkingLabel}`;
				}
				updateLoopStatus(ctx);
				const rotationSuffix = loopState!.rotationLabel ? ` [${loopState!.rotationLabel}]` : "";
				notify(ctx, `Loop ${iterationLabel}: ${name}${rotationSuffix}`, "info");

				const loopContext = loopState!.rotationLabel
					? `Loop ${iterationLabel} · ${loopState!.rotationLabel}`
					: `Loop ${iterationLabel}`;
				const iterationStartId = ctx.sessionManager.getLeafId();
				const stepResult = await executePromptStep(
					iterationPrompt,
					parseCommandArgs(cleanedArgs),
					ctx,
					currentModel,
					subagentOverride,
					undefined,
					undefined,
					loopContext,
				);
				if (stepResult === "aborted") {
					runStatus = ctx.signal?.aborted ? "cancelled" : "failed";
					loopAborted = true;
					break;
				}
				if (stepResult.status && stepResult.status !== "completed") runStatus = stepResult.status;
				const delegatedStep = shouldDelegatePrompt(iterationPrompt, subagentOverride);
				if (delegatedStep) {
					lastDelegatedText = stepResult.text;
				}

				currentModel = getCurrentModel(ctx);
				currentThinking = pi.getThinkingLevel();
				completedIterations++;

				const iterationChanged = delegatedStep
					? stepResult.changed
					: didIterationMakeChanges(getIterationEntries(ctx, iterationStartId));
				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (useFresh && anchorId && i < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: name, iteration: i + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						runStatus = "cancelled";
						loopAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}
		} catch (error) {
			runStatus = ctx.signal?.aborted ? "cancelled" : "failed";
			loopErrorState = { hasError: true, error };
		} finally {
			loopErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				savedModel,
				savedThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				loopErrorState,
				"loop",
			);

			boomerangPreviousSummaries = accumulatedSummaries;
			loopState = null;
			pendingSkillMessage = undefined;
			freshCollapse = null;
			boomerangCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (!loopErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, false);
			}
		}

		if (lastDelegatedText && !loopErrorState.hasError && !loopAborted) {
			const label = converged
				? `Delegated loop converged after ${completedIterations} iteration(s): ${name}`
				: `Delegated loop completed ${completedIterations} iteration(s): ${name}`;
			pi.sendUserMessage(`[${label}]\n\n${lastDelegatedText}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (!loopErrorState.hasError && !loopAborted && shouldBoomerang) {
			await collapseBoomerangPrompt(ctx, name, anchorId, boomerangPreviousSummaries);
		}

		if (loopErrorState.hasError) {
			throw loopErrorState.error;
		}
		return runStatus;
	}

	async function runSharedChainExecution(
		steps: ChainStepOrParallel[],
		sharedArgs: string[],
		totalIterations: number | null,
		fresh: boolean,
		converge: boolean,
		shouldRestore: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		chainContextEnabled = false,
		chainTemplateWorktree = false,
		cliWorktree = false,
	) {
		let worktreeEnabled = chainTemplateWorktree || cliWorktree;
		if (worktreeEnabled && !steps.some(isParallelChainStep)) {
			notify(ctx, `--worktree ignored: chain has no parallel() steps`, "warning");
			worktreeEnabled = false;
		}
		const flattenChainSteps = (): ChainStep[] => {
			const flattened: ChainStep[] = [];
			for (const step of steps) {
				if (isParallelChainStep(step)) {
					flattened.push(...step.parallel);
				} else {
					flattened.push(step);
				}
			}
			return flattened;
		};

		const validateChainSteps = (): boolean => {
			const flattened = flattenChainSteps();
			const missingTemplates = flattened.filter((step) => !chainPrompts.has(step.name));
			if (missingTemplates.length > 0) {
				notify(ctx, `Templates not found: ${missingTemplates.map((step) => step.name).join(", ")}`, "error");
				return false;
			}

			for (const step of steps) {
				if (isParallelChainStep(step)) {
					for (const parallelStep of step.parallel) {
						if (parallelStep.loopCount !== undefined) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() does not support per-task --loop.`, "error");
							return false;
						}
						if (parallelStep.withContext === true) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() does not support per-task --with-context.`, "error");
							return false;
						}
						const stepPrompt = chainPrompts.get(parallelStep.name);
						if (!stepPrompt) continue;
						if (stepPrompt.chain) {
							notify(ctx, `Step "${parallelStep.name}" is a chain template. Chain nesting is not supported.`, "error");
							return false;
						}
						if (!shouldDelegatePrompt(stepPrompt, subagentOverride)) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() must use delegated execution (subagent).`, "error");
							return false;
						}
					}
					continue;
				}

				const stepPrompt = chainPrompts.get(step.name);
				if (!stepPrompt) continue;
				if (stepPrompt.chain) {
					notify(ctx, `Step "${step.name}" is a chain template. Chain nesting is not supported.`, "error");
					return false;
				}
			}

			return true;
		};

		if (!validateChainSteps()) return;

		const originalModel = getCurrentModel(ctx);
		const chainInheritedModel = originalModel;
		const originalThinking = pi.getThinkingLevel();
		let currentModel = originalModel;
		let currentThinking = originalThinking;
		chainActive = true;
		pendingSkillMessage = undefined;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge;

		const anchorId = fresh ? ctx.sessionManager.getLeafId() : null;
		const chainStepNames = steps
			.map((step) => (isParallelChainStep(step) ? `parallel(${step.parallel.map((item) => item.name).join(", ")})` : step.name))
			.join(" -> ");
		let completedIterations = 0;
		let converged = false;
		let chainErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		let lastDelegatedText: string | undefined;
		let chainAborted = false;
		if (effectiveMax > 1) {
			loopState = { currentIteration: 1, totalIterations };
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
		}

		try {
			for (let iteration = 0; iteration < effectiveMax; iteration++) {
				if (effectiveMax > 1) {
					loopState!.currentIteration = iteration + 1;
					updateLoopStatus(ctx);
					refreshPrompts(ctx.cwd, ctx);
					if (!validateChainSteps()) {
						chainAborted = true;
						break;
					}
				}

				const templates = steps.map((step) =>
					isParallelChainStep(step)
						? {
							kind: "parallel" as const,
							tasks: step.parallel.map((item) => ({
								name: item.name,
								args: item.args,
								prompt: {
									...chainPrompts.get(item.name)!,
									...(cwdOverride ? { cwd: cwdOverride } : {}),
								},
							})),
						}
						: {
							kind: "single" as const,
							singleStep: {
								prompt: {
									...chainPrompts.get(step.name)!,
									...(cwdOverride ? { cwd: cwdOverride } : {}),
								},
								stepArgs: step.args,
								stepLoop: step.loopCount !== undefined ? step.loopCount : 1,
								stepWithContext: step.withContext === true,
							},
						},
				);
				const chainStepSummaries: string[] = [];
				let aborted = false;
				let iterationChanged = false;
				let loopPrefix = "";
				if (effectiveMax > 1) {
					const label = totalIterations !== null ? `${iteration + 1}/${totalIterations}` : `${iteration + 1}`;
					loopPrefix = `Loop ${label}, `;
				}

				for (const [index, stepTemplate] of templates.entries()) {
					const stepNumber = index + 1;
					if (stepTemplate.kind === "parallel") {
						const stepNames = stepTemplate.tasks.map((task) => task.name).join(", ");
						const stepLabel = `parallel(${stepNames})`;
						notify(ctx, `${loopPrefix}Step ${stepNumber}/${templates.length}: parallel(${stepNames})`, "info");
						if (ctx.hasUI) {
							ctx.ui.setStatus("prompt-chain", ctx.ui.theme.fg("warning", `step ${stepNumber}/${templates.length}: parallel(${stepNames})`));
						}
						const stepStartId = ctx.sessionManager.getLeafId();
						let taskPreamble: string | undefined;
						const isForkedParallelContext = stepTemplate.tasks.some((task) => task.prompt.inheritContext === true);
						if (chainContextEnabled && !isForkedParallelContext && chainStepSummaries.length > 0) {
							taskPreamble = `[Previous chain steps]\n\n${chainStepSummaries.join("\n\n")}`;
						}

						let delegated;
						try {
							delegated = await executeSubagentPromptStep({
								pi,
								ctx,
								resolveSkillBindings: (skillNames, cwd) => resolveDelegatedSkillBindings(skillNames, cwd, ctx),
								currentModel,
								override: subagentOverride,
								signal: ctx.signal,
								inheritedModel: chainInheritedModel,
								parallel: stepTemplate.tasks.map((task) => ({
									prompt: task.prompt,
									args: task.args.length > 0 ? task.args : sharedArgs,
								})),
								taskPreamble,
								worktree: worktreeEnabled,
							});
						} catch (error) {
							notify(ctx, error instanceof Error ? error.message : String(error), "error");
							aborted = true;
							break;
						}
						if (!delegated) {
							notify(ctx, "Parallel chain step was not delegated.", "error");
							aborted = true;
							break;
						}
						lastDelegatedText = delegated.text;

						currentModel = getCurrentModel(ctx);
						currentThinking = pi.getThinkingLevel();
						const stepEntries = getIterationEntries(ctx, stepStartId);
						if (delegated.changed) iterationChanged = true;
						chainStepSummaries.push(generateChainStepSummary(stepEntries, stepLabel, stepNumber));
						continue;
					}

					const singleStep = stepTemplate.singleStep;
					const stepLoopTotal = singleStep.stepLoop;
					const stepLoopMax = stepLoopTotal ?? UNLIMITED_LOOP_CAP;
					const isStepLooping = stepLoopMax > 1;
					const effectiveArgs = singleStep.stepArgs.length > 0 ? singleStep.stepArgs : sharedArgs;
					const shouldInjectSummary =
						shouldDelegatePrompt(singleStep.prompt, subagentOverride) &&
						singleStep.prompt.inheritContext !== true &&
						(chainContextEnabled || singleStep.stepWithContext === true);
					const outerLoopState = loopState ? { ...loopState } : null;
					const stepStartId = ctx.sessionManager.getLeafId();
					if (isStepLooping) {
						loopState = { currentIteration: 1, totalIterations: stepLoopTotal };
						updateLoopStatus(ctx);
					}

					try {
						for (let stepIteration = 0; stepIteration < stepLoopMax; stepIteration++) {
							if (isStepLooping) {
								loopState = { currentIteration: stepIteration + 1, totalIterations: stepLoopTotal };
								updateLoopStatus(ctx);
							}

							const iterSuffix = isStepLooping
								? stepLoopTotal !== null
									? ` (iter ${stepIteration + 1}/${stepLoopTotal})`
									: ` (iter ${stepIteration + 1})`
								: "";
							notify(
								ctx,
								`${loopPrefix}Step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}${iterSuffix} ${buildPromptCommandDescription(singleStep.prompt)}`,
								"info",
							);
							if (ctx.hasUI) {
								ctx.ui.setStatus("prompt-chain", ctx.ui.theme.fg("warning", `step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}`));
							}
							const taskPreamble = shouldInjectSummary && chainStepSummaries.length > 0
								? `[Previous chain steps]\n\n${chainStepSummaries.join("\n\n")}`
								: undefined;

							const stepLoopContext = isStepLooping
								? `Step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}${iterSuffix}`
								: undefined;
							const stepIterationStartId = ctx.sessionManager.getLeafId();
							const stepResult = await executePromptStep(
								singleStep.prompt,
								effectiveArgs,
								ctx,
								currentModel,
								subagentOverride,
								chainInheritedModel,
								taskPreamble,
								stepLoopContext,
							);
							if (stepResult === "aborted") {
								chainAborted = true;
								aborted = true;
								break;
							}
							if (shouldDelegatePrompt(singleStep.prompt, subagentOverride)) {
								lastDelegatedText = stepResult.text;
							}

							currentModel = getCurrentModel(ctx);
							currentThinking = pi.getThinkingLevel();

							const stepIterationEntries = getIterationEntries(ctx, stepIterationStartId);
							const stepIterationChanged = didIterationMakeChanges(stepIterationEntries);
							if (isStepLooping && singleStep.prompt.converge !== false && !stepIterationChanged) {
								break;
							}
						}
					} finally {
						if (isStepLooping) {
							loopState = outerLoopState ? { ...outerLoopState } : null;
							updateLoopStatus(ctx);
						}
					}

					if (aborted) break;
					const stepEntries = getIterationEntries(ctx, stepStartId);
					if (didIterationMakeChanges(stepEntries)) iterationChanged = true;
					chainStepSummaries.push(generateChainStepSummary(stepEntries, singleStep.prompt.name, stepNumber));
				}

				if (aborted) {
					chainAborted = true;
					break;
				}
				completedIterations++;

				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (anchorId && iteration < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: chainStepNames, iteration: iteration + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						chainAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}

		} catch (error) {
			chainErrorState = { hasError: true, error };
		} finally {
			chainErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				originalModel,
				originalThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				chainErrorState,
				"chain",
			);

			pendingSkillMessage = undefined;
			chainActive = false;
			loopState = null;
			freshCollapse = null;
			boomerangCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
			if (ctx.hasUI) {
				ctx.ui.setStatus("prompt-chain", undefined);
			}

			if (!chainErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, true);
			}
		}

		if (lastDelegatedText && !chainErrorState.hasError && !chainAborted) {
			pi.sendUserMessage(`[Delegated chain complete: ${chainStepNames}]\n\n${lastDelegatedText}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (chainErrorState.hasError) {
			throw chainErrorState.error;
		}
	}

	async function executePromptCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<PromptTemplatePromptStatus> {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return "failed";
		}

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return "failed";
		}
		const argsWithoutSubagent = subagent.args;
		if (prompt.deterministic) {
			if (subagent.override || subagent.fork) {
				notify(ctx, `Deterministic prompts do not support runtime --subagent/--fork in v1`, "error");
				return "failed";
			}
			if (extractLoopCount(argsWithoutSubagent)) {
				notify(ctx, `Deterministic prompts do not support runtime --loop in v1`, "error");
				return "failed";
			}
		}

		const hasCompareLineup = prompt.workers !== undefined || prompt.reviewers !== undefined || prompt.finalApplier !== undefined;
		if (hasCompareLineup) {
			await runComparePrompt(
				name,
				prompt,
				argsWithoutSubagent,
				ctx,
				getCurrentModel(ctx),
				{
					cwd: runtimeCwd,
					model: subagent.model,
					subagentOverride: subagent.override,
					fork: subagent.fork,
				},
			);
			return ctx.signal?.aborted ? "cancelled" : "completed";
		}

		if (prompt.chain) {
			if (subagent.model) notify(ctx, `--model is not supported on chain prompts (ignored)`, "warning");
			if (subagent.fork) notify(ctx, `--fork is not supported on chain prompts (ignored)`, "warning");
			const worktreeExtraction = extractWorktreeFlag(argsWithoutSubagent);
			const extracted = extractChainContextFlag(worktreeExtraction.args);
			const chainContextEnabled = extracted.chainContext || prompt.chainContext === "summary";
			const cliWorktree = worktreeExtraction.worktree;
			const loop = extractLoopCount(extracted.args);
			let totalIterations: number | null = prompt.loop !== undefined ? prompt.loop : 1;
			let fresh = false;
			let converge = true;
			let cleanedArgs = extracted.args;

			if (loop) {
				totalIterations = loop.loopCount;
				fresh = loop.fresh;
				converge = loop.converge;
				cleanedArgs = loop.args;
			} else if (prompt.loop !== undefined) {
				const flags = extractLoopFlags(extracted.args);
				fresh = flags.fresh;
				converge = flags.converge;
				cleanedArgs = flags.args;
			}

			const { steps, invalidSegments } = parseChainDeclaration(prompt.chain);
			if (invalidSegments.length > 0) {
				notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
				return "failed";
			}
			if (steps.length === 0) {
				notify(ctx, "No templates specified", "error");
				return "failed";
			}

			const cwdOverride = runtimeCwd ?? prompt.cwd;
			await runSharedChainExecution(
				steps,
				parseCommandArgs(cleanedArgs),
				totalIterations,
				fresh || prompt.fresh === true,
				converge && prompt.converge !== false,
				prompt.restore,
				ctx,
				subagent.override,
				cwdOverride,
				chainContextEnabled,
				prompt.worktree === true,
				cliWorktree,
			);
			return ctx.signal?.aborted ? "cancelled" : "completed";
		}

		const promptOverrides: Partial<Pick<PromptWithModel, "models" | "inheritContext">> = {
			...(subagent.model ? { models: [subagent.model] } : {}),
			...(subagent.fork ? { inheritContext: true } : {}),
		};

		const loop = extractLoopCount(argsWithoutSubagent);
		if (loop) {
			return await runPromptLoop(name, loop.args, loop.loopCount, loop.fresh, loop.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
		}

		if (prompt.loop !== undefined) {
			const flags = extractLoopFlags(argsWithoutSubagent);
			return await runPromptLoop(name, flags.args, prompt.loop, flags.fresh, flags.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
		}

		const effectivePrompt = {
			...prompt,
			...(runtimeCwd ? {
				cwd: runtimeCwd,
				...(prompt.deterministic ? { deterministic: { ...prompt.deterministic, cwd: runtimeCwd } } : {}),
			} : {}),
			...promptOverrides,
		};
		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		const isDelegatedPrompt = shouldDelegatePrompt(effectivePrompt, subagent.override);
		const promptTurnRestore = !isDelegatedPrompt && prompt.restore
			? { originalModel: savedModel, originalThinking: savedThinking }
			: undefined;
		const boomerangTargetId = effectivePrompt.boomerang ? ctx.sessionManager.getLeafId() : null;
		const stepResult = await executePromptStep(
			effectivePrompt,
			parseCommandArgs(argsWithoutSubagent),
			ctx,
			savedModel,
			subagent.override,
			undefined,
			undefined,
			undefined,
			promptTurnRestore,
		);
		if (stepResult === "aborted") return ctx.signal?.aborted ? "cancelled" : "failed";
		if (isDelegatedPrompt && stepResult.text) {
			pi.sendUserMessage(`[Delegated result: ${name}]\n\n${stepResult.text}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (effectivePrompt.boomerang) {
			await collapseBoomerangPrompt(ctx, name, boomerangTargetId);
		}
		return stepResult.status ?? (ctx.signal?.aborted ? "cancelled" : "completed");
	}

	async function runPromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const runId = randomUUID();
		const startId = ctx.sessionManager.getLeafId();
		const started: PromptTemplatePromptStarted = {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
			runId,
			name,
		};
		emitPromptLifecycleEvent(pi, PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, started);

		let status: PromptTemplatePromptStatus = "completed";
		try {
			status = await executePromptCommand(name, args, ctx);
		} catch (error) {
			status = ctx.signal?.aborted ? "cancelled" : "failed";
			throw error;
		} finally {
			const entries = getIterationEntries(ctx, startId);
			const lastText = getLastAssistantText(entries);
			const finished: PromptTemplatePromptFinished = {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
				runId,
				name,
				status: ctx.signal?.aborted && status === "completed" ? "cancelled" : status,
				changed: didIterationMakeChanges(entries),
				...(lastText ? { lastText } : {}),
			};
			emitPromptLifecycleEvent(pi, PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, finished);
		}
	}

	function resetSessionScopedState(ctx: ExtensionContext) {
		storedCommandCtx = null;
		pendingSkillMessage = undefined;
		previousModel = undefined;
		previousThinking = undefined;
		runtimeModel = ctx.model;
		boomerangCollapse = null;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("model_select", async (event) => {
		runtimeModel = event.model;
	});

	pi.on("before_agent_start", async (event) => {
		let systemPrompt = event.systemPrompt;

		if (toolManager.isEnabled() && !loopState && !chainActive) {
			const toolGuidance = toolManager.getGuidance();
			const guidance = toolGuidance
				? `The run-prompt tool is available for running prompt template commands. ${toolGuidance}`
				: "The run-prompt tool is available for running prompt template commands.";
			systemPrompt += `\n\n${guidance}`;
		}

		if (loopState) {
			const iterText =
				loopState.totalIterations !== null
					? `iteration ${loopState.currentIteration} of ${loopState.totalIterations}`
					: `iteration ${loopState.currentIteration}`;
			systemPrompt += `\n\nYou are on ${iterText} of the same prompt. Previous iterations and their results are visible in the conversation above. Build on that work — focus on what remains to improve.`;
		}

		const skillMessage = consumePendingSkillMessage();
		const hasSystemPromptOverride = systemPrompt !== event.systemPrompt;
		if (!hasSystemPromptOverride && !skillMessage) return;

		return {
			...(hasSystemPromptOverride ? { systemPrompt } : {}),
			...(skillMessage ? { message: skillMessage } : {}),
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (chainActive) return;
		if (loopState) return;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		if (!restoreModel && restoreThinking === undefined && !toolManager.hasQueuedCommand()) return;

		runtimeModel = ctx.model;

		previousModel = undefined;
		previousThinking = undefined;

		const restoreFn = async () => {
			if (restoreModel || restoreThinking !== undefined) {
				await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
			}
		};
		const processed = await toolManager.processQueue(ctx, restoreFn);
		if (processed) return;
		await restoreFn();
	});

	pi.on("session_before_tree", async (event) => {
		if (boomerangCollapse && event.preparation.targetId === boomerangCollapse.targetId) {
			const summary = generateBoomerangSummary(event.preparation.entriesToSummarize, boomerangCollapse.task);
			return {
				summary: {
					summary: [...boomerangCollapse.previousSummaries, summary].join("\n\n---\n\n"),
				},
			};
		}

		if (!freshCollapse) return;
		if (event.preparation.targetId !== freshCollapse.targetId) return;

		const summary = generateIterationSummary(
			event.preparation.entriesToSummarize,
			freshCollapse.task,
			freshCollapse.iteration,
			freshCollapse.totalIterations,
		);
		accumulatedSummaries.push(summary);

		return {
			summary: {
				summary: accumulatedSummaries.join("\n\n---\n\n"),
			},
		};
	});

	async function runChainCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return;
		}
		const worktreeExtraction = extractWorktreeFlag(subagent.args);
		const extracted = extractChainContextFlag(worktreeExtraction.args);
		const loop = extractLoopCount(extracted.args);
		const cleanedArgs = loop ? loop.args : extracted.args;

		const { steps, sharedArgs, invalidSegments } = parseChainSteps(cleanedArgs);
		if (invalidSegments.length > 0) {
			notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
			return;
		}
		if (steps.length === 0) {
			notify(ctx, "No templates specified", "error");
			return;
		}

		await runSharedChainExecution(
			steps,
			sharedArgs,
			loop ? loop.loopCount : 1,
			loop?.fresh === true,
			loop?.converge ?? true,
			true,
			ctx,
			subagent.override,
			runtimeCwd,
			extracted.chainContext,
			false,
			worktreeExtraction.worktree,
		);
	}

	if (toolManager.isEnabled()) toolManager.ensureRegistered();

	pi.registerCommand("chain-prompts", {
		description: "Chain prompt templates sequentially [template -> template -> ...]",
		handler: async (args, ctx) => {
			await runChainCommand(args, ctx);
		},
	});
	toolManager.registerCommand();
}

/**
 * Prompt Model Extension
 *
 * Adds support for `model`, `skill`, and `thinking` frontmatter in prompt template .md files.
 * Create specialized agent modes that switch to the right model, set thinking level,
 * and inject the right skill, then auto-restore when done.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                                                                             │
 * │  You're using Opus                                                          │
 * │       │                                                                     │
 * │       ▼                                                                     │
 * │  /debug-python  ──►  Extension detects model + skill frontmatter            │
 * │       │                                                                     │
 * │       ▼                                                                     │
 * │  Switches to Sonnet  ──►  Stores "Opus" as previous model                   │
 * │       │                                                                     │
 * │       ▼                                                                     │
 * │  before_agent_start  ──►  Injects tmux skill into system prompt             │
 * │       │                                                                     │
 * │       ▼                                                                     │
 * │  Agent responds with Sonnet + tmux expertise                                │
 * │       │                                                                     │
 * │       ▼                                                                     │
 * │  agent_end fires  ──►  Restores Opus  ──►  Shows "Restored to opus" notif   │
 * │       │                                                                     │
 * │       ▼                                                                     │
 * │  You're back on Opus                                                        │
 * │                                                                             │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Prompt template locations:
 * - ~/.pi/agent/prompts/**\/*.md (global, recursive)
 * - <cwd>/.pi/prompts/**\/*.md (project-local, recursive)
 *
 * Skill locations (checked in order):
 * - <cwd>/.pi/skills/{name}/SKILL.md (project)
 * - ~/.pi/agent/skills/{name}/SKILL.md (user)
 *
 * Example prompt file (e.g., ~/.pi/agent/prompts/debug-python.md):
 * ```markdown
 * ---
 * description: Debug Python in tmux REPL
 * model: claude-sonnet-4-20250514
 * skill: tmux
 * ---
 * Start a Python REPL session and help me debug: $@
 * ```
 *
 * Frontmatter fields:
 * - `description`: Description shown in autocomplete (standard)
 * - `model`: Model ID, "provider/model-id", or comma-separated list for fallback
 *            e.g., "claude-haiku-4-5" or "claude-haiku-4-5, claude-sonnet-4-20250514"
 * - `skill`: Skill name to inject into system prompt (e.g., "tmux")
 * - `thinking`: Thinking level (off, minimal, low, medium, high, xhigh)
 * - `restore`: Whether to restore the previous model/thinking after response (default: true)
 *
 * Usage:
 * - `/debug-python my code is broken` - switches model, injects skill, runs prompt
 *
 * Notes:
 * - Templates without `model` frontmatter work normally (handled by pi core)
 * - Skills are injected via the before_agent_start hook into the system prompt
 * - Subdirectories create namespaced commands shown as (user:subdir) or (project:subdir)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageRenderOptions, Theme } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Box, Text, Spacer, Container } from "@mariozechner/pi-tui";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

interface PromptWithModel {
	name: string;
	description: string;
	content: string;
	models: string[];
	restore: boolean;
	skill?: string;
	thinking?: ThinkingLevel;
	source: "user" | "project";
	subdir?: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; content: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, content: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, content: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, content: body };
}

/**
 * Parse command arguments respecting quoted strings.
 */
function parseCommandArgs(argsString: string): string[] {
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
		} else if (char === " " || char === "\t") {
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

/**
 * Substitute argument placeholders in template content.
 */
function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. with positional args
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	const allArgs = args.join(" ");

	// Replace $ARGUMENTS and $@ with all args
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);

	return result;
}

/**
 * Resolve skill path from name. Checks project first, then user.
 */
function resolveSkillPath(skillName: string, cwd: string): string | undefined {
	// Project skills first
	const projectPath = resolve(cwd, ".pi", "skills", skillName, "SKILL.md");
	if (existsSync(projectPath)) return projectPath;

	// Fall back to user skills
	const userPath = join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md");
	if (existsSync(userPath)) return userPath;

	return undefined;
}

/**
 * Read skill content, stripping frontmatter.
 */
function readSkillContent(skillPath: string): string | undefined {
	try {
		const raw = readFileSync(skillPath, "utf-8");
		const { content } = parseFrontmatter(raw);
		return content;
	} catch {
		return undefined;
	}
}

/**
 * Load prompt templates that have model frontmatter from a directory.
 * Recursively scans subdirectories.
 */
function loadPromptsWithModelFromDir(
	dir: string,
	source: "user" | "project",
	subdir = ""
): PromptWithModel[] {
	const prompts: PromptWithModel[] = [];

	if (!existsSync(dir)) {
		return prompts;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// Handle symlinks
			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
					isDirectory = stats.isDirectory();
				} catch {
					continue;
				}
			}

			// Recurse into subdirectories
			if (isDirectory) {
				const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				prompts.push(...loadPromptsWithModelFromDir(fullPath, source, newSubdir));
				continue;
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const { frontmatter, content: body } = parseFrontmatter(rawContent);

				// Only include templates that have a model field
				if (!frontmatter.model) continue;

				const models = frontmatter.model.split(",").map(s => s.trim()).filter(Boolean);
				if (models.length === 0) continue;

				const name = entry.name.slice(0, -3); // Remove .md

				// Parse restore field (default: true)
				const restore = frontmatter.restore?.toLowerCase() !== "false";

				// Parse thinking level if valid
				const thinkingRaw = frontmatter.thinking?.toLowerCase();
				const validThinking = thinkingRaw && (VALID_THINKING_LEVELS as readonly string[]).includes(thinkingRaw)
					? thinkingRaw as ThinkingLevel
					: undefined;

				prompts.push({
					name,
					description: frontmatter.description || "",
					content: body,
					models,
					restore,
					skill: frontmatter.skill || undefined,
					thinking: validThinking,
					source,
					subdir: subdir || undefined,
				});
			} catch {
				// Skip files that can't be read or parsed
			}
		}
	} catch {
		// Skip directories that can't be read
	}

	return prompts;
}

/**
 * Load all prompt templates with model frontmatter.
 * Project templates override global templates with the same name.
 */
function loadPromptsWithModel(cwd: string): Map<string, PromptWithModel> {
	const globalDir = join(homedir(), ".pi", "agent", "prompts");
	const projectDir = resolve(cwd, ".pi", "prompts");

	const promptMap = new Map<string, PromptWithModel>();

	// Load global first
	for (const prompt of loadPromptsWithModelFromDir(globalDir, "user")) {
		promptMap.set(prompt.name, prompt);
	}

	// Project overrides global
	for (const prompt of loadPromptsWithModelFromDir(projectDir, "project")) {
		promptMap.set(prompt.name, prompt);
	}

	return promptMap;
}

/** Details for skill-loaded custom message */
interface SkillLoadedDetails {
	skillName: string;
	skillContent: string;
	skillPath: string;
}

/** Max lines to show when collapsed */
const SKILL_PREVIEW_LINES = 5;

/**
 * Render the skill-loaded message with expandable content
 */
function renderSkillLoaded(
	message: { details?: SkillLoadedDetails },
	options: MessageRenderOptions,
	theme: Theme
) {
	const { skillName, skillContent, skillPath } = message.details!;
	const container = new Container();
	
	container.addChild(new Spacer(1));
	
	const box = new Box(1, 1, (t: string) => theme.bg("toolSuccessBg", t));
	
	// Header with skill name
	const header = theme.fg("toolTitle", theme.bold(`⚡ Skill loaded: ${skillName}`));
	box.addChild(new Text(header, 0, 0));
	
	// Show path in muted color
	const pathLine = theme.fg("toolOutput", `   ${skillPath}`);
	box.addChild(new Text(pathLine, 0, 0));
	box.addChild(new Spacer(1));
	
	// Content preview or full content
	const lines = skillContent.split("\n");
	
	if (options.expanded) {
		// Show full content
		const content = lines.map(line => theme.fg("toolOutput", line)).join("\n");
		box.addChild(new Text(content, 0, 0));
	} else {
		// Show truncated preview
		const previewLines = lines.slice(0, SKILL_PREVIEW_LINES);
		const remaining = lines.length - SKILL_PREVIEW_LINES;
		
		const preview = previewLines.map(line => theme.fg("toolOutput", line)).join("\n");
		box.addChild(new Text(preview, 0, 0));
		
		if (remaining > 0) {
			box.addChild(new Text(theme.fg("warning", `\n... (${remaining} more lines)`), 0, 0));
		}
	}
	
	container.addChild(box);
	return container;
}

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkill: { name: string; cwd: string } | undefined;
	
	// Register custom message renderer for skill-loaded messages
	pi.registerMessageRenderer<SkillLoadedDetails>("skill-loaded", renderSkillLoaded);

	/**
	 * Find and resolve a model from "provider/model-id" or just "model-id".
	 * If no provider is specified, searches all models by ID.
	 * Prefers models with auth, then by provider priority: anthropic > github-copilot > openrouter.
	 * Returns undefined if the model can't be resolved (caller handles notifications).
	 */
	function resolveModel(modelSpec: string, ctx: ExtensionContext): Model<any> | undefined {
		const slashIndex = modelSpec.indexOf("/");

		if (slashIndex !== -1) {
			const provider = modelSpec.slice(0, slashIndex);
			const modelId = modelSpec.slice(slashIndex + 1);

			if (!provider || !modelId) return undefined;

			return ctx.modelRegistry.find(provider, modelId);
		}

		const allMatches = ctx.modelRegistry.getAll().filter((m) => m.id === modelSpec);

		if (allMatches.length === 0) return undefined;
		if (allMatches.length === 1) return allMatches[0];

		const availableMatches = ctx.modelRegistry.getAvailable().filter((m) => m.id === modelSpec);

		if (availableMatches.length === 1) return availableMatches[0];

		if (availableMatches.length > 1) {
			const preferredProviders = ["anthropic", "github-copilot", "openrouter"];
			for (const provider of preferredProviders) {
				const preferred = availableMatches.find((m) => m.provider === provider);
				if (preferred) return preferred;
			}
			return availableMatches[0];
		}

		return undefined;
	}

	/**
	 * Try each model spec in order. Return the first one that resolves and has auth.
	 * If the current model matches a candidate, use it without switching.
	 * Calls pi.setModel() for the first viable candidate, so the caller must
	 * capture ctx.model beforehand if restore is needed.
	 */
	async function resolveAndSwitch(
		modelSpecs: string[],
		ctx: ExtensionContext,
	): Promise<{ model: Model<any>; alreadyActive: boolean } | undefined> {
		for (const spec of modelSpecs) {
			const model = resolveModel(spec, ctx);
			if (!model) continue;

			if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
				return { model, alreadyActive: true };
			}

			const success = await pi.setModel(model);
			if (success) {
				return { model, alreadyActive: false };
			}
		}

		ctx.ui.notify(`No available model from: ${modelSpecs.join(", ")}`, "error");
		return undefined;
	}

	// Reload prompts on session start (in case cwd changed)
	pi.on("session_start", async (_event, ctx) => {
		prompts = loadPromptsWithModel(ctx.cwd);
	});

	// Inject skill into system prompt before agent starts
	pi.on("before_agent_start", async (event, ctx) => {
		if (!pendingSkill) {
			return;
		}

		const { name: skillName, cwd } = pendingSkill;
		pendingSkill = undefined;

		const skillPath = resolveSkillPath(skillName, cwd);
		if (!skillPath) {
			ctx.ui.notify(`Skill "${skillName}" not found`, "error");
			return;
		}

		const skillContent = readSkillContent(skillPath);
		if (skillContent === undefined) {
			ctx.ui.notify(`Failed to read skill "${skillName}"`, "error");
			return;
		}

		// Send a custom message to display the skill loaded notification
		pi.sendMessage<SkillLoadedDetails>({
			customType: "skill-loaded",
			content: `Loaded skill: ${skillName}`,
			display: true,
			details: {
				skillName,
				skillContent,
				skillPath,
			},
		});

		// Append skill to system prompt wrapped in <skill> tags
		return {
			systemPrompt: `${event.systemPrompt}\n\n<skill name="${skillName}">\n${skillContent}\n</skill>`,
		};
	});

	// Restore model and thinking level after the agent finishes responding
	pi.on("agent_end", async (_event, ctx) => {
		const restoredParts: string[] = [];

		if (previousModel) {
			restoredParts.push(previousModel.id);
			await pi.setModel(previousModel);
			previousModel = undefined;
		}

		if (previousThinking !== undefined) {
			restoredParts.push(`thinking:${previousThinking}`);
			pi.setThinkingLevel(previousThinking);
			previousThinking = undefined;
		}

		if (restoredParts.length > 0) {
			ctx.ui.notify(`Restored to ${restoredParts.join(", ")}`, "info");
		}
	});

	// Initialize: register commands for prompts with model frontmatter
	const initialCwd = process.cwd();
	const initialPrompts = loadPromptsWithModel(initialCwd);

	for (const [name, prompt] of initialPrompts) {
		// Build source label with subdir namespace
		let sourceLabel: string;
		if (prompt.subdir) {
			sourceLabel = `(${prompt.source}:${prompt.subdir})`;
		} else {
			sourceLabel = `(${prompt.source})`;
		}

		// Build model label (short form, pipe-separated for fallbacks)
		const modelLabel = prompt.models
			.map(m => m.split("/").pop() || m)
			.join("|");

		// Build skill label if present
		const skillLabel = prompt.skill ? ` +${prompt.skill}` : "";

		// Build thinking label if present
		const thinkingLabel = prompt.thinking ? ` ${prompt.thinking}` : "";

		pi.registerCommand(name, {
			description: prompt.description
				? `${prompt.description} [${modelLabel}${thinkingLabel}${skillLabel}] ${sourceLabel}`
				: `[${modelLabel}${thinkingLabel}${skillLabel}] ${sourceLabel}`,

			handler: async (args, ctx) => {
				// Re-fetch the prompt in case it was updated
				const currentPrompt = prompts.get(name);
				if (!currentPrompt) {
					ctx.ui.notify(`Prompt "${name}" no longer exists`, "error");
					return;
				}

				// Capture current state before any switching (needed for restore)
				const savedModel = ctx.model;
				const savedThinking = pi.getThinkingLevel();

				// Resolve and switch to the first available model from the list
				const result = await resolveAndSwitch(currentPrompt.models, ctx);
				if (!result) return;

				if (!result.alreadyActive && currentPrompt.restore) {
					previousModel = savedModel;
					previousThinking = savedThinking;
				}

				// Set thinking level if specified
				if (currentPrompt.thinking) {
					if (currentPrompt.restore && previousThinking === undefined && currentPrompt.thinking !== savedThinking) {
						previousThinking = savedThinking;
					}
					pi.setThinkingLevel(currentPrompt.thinking);
				}

				// Set pending skill for before_agent_start handler
				if (currentPrompt.skill) {
					pendingSkill = { name: currentPrompt.skill, cwd: ctx.cwd };
				}

				// Expand the template with arguments
				const parsedArgs = parseCommandArgs(args);
				const expandedContent = substituteArgs(currentPrompt.content, parsedArgs);

				// Send the expanded prompt as a user message
				pi.sendUserMessage(expandedContent);

				// Wait for agent to start processing, then wait for it to finish
				// (required for print mode, harmless in interactive)
				while (ctx.isIdle()) {
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				await ctx.waitForIdle();
			},
		});
	}
}

/**
 * Prompt Model Extension
 *
 * Adds support for `model` frontmatter in prompt template .md files.
 * When a template specifies a model, it automatically switches to that model
 * before executing the prompt, then restores the previous model after the response.
 *
 * Prompt template location:
 * - ~/.pi/agent/prompts/*.md (global)
 * - <cwd>/.pi/prompts/*.md (project-local)
 *
 * Example prompt file (e.g., ~/.pi/agent/prompts/quick.md):
 * ```markdown
 * ---
 * description: Quick answer without deep thinking
 * model: claude-sonnet-4-20250514
 * ---
 * Answer this question concisely: $@
 * ```
 *
 * Frontmatter fields:
 * - `description`: Description shown in autocomplete (standard)
 * - `model`: Model ID (e.g., "claude-sonnet-4-20250514") or full "provider/model-id"
 *
 * Usage:
 * - `/quick what is the capital of France` - switches to specified model, runs prompt
 *
 * Notes:
 * - Templates without `model` frontmatter work normally (no model switching)
 * - This extension intercepts prompts with model frontmatter as commands
 * - The template content is sent as a user message after model switch
 * - The previous model is automatically restored after the response completes
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface PromptWithModel {
	name: string;
	description: string;
	content: string;
	model: string; // model ID or "provider/model-id"
	source: "user" | "project";
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
			// Remove quotes if present
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
 * Load prompt templates that have model frontmatter from a directory.
 */
function loadPromptsWithModelFromDir(dir: string, source: "user" | "project"): PromptWithModel[] {
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
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const { frontmatter, content: body } = parseFrontmatter(rawContent);

				// Only include templates that have a model field
				if (!frontmatter.model) continue;

				const name = entry.name.slice(0, -3); // Remove .md

				prompts.push({
					name,
					description: frontmatter.description || "",
					content: body,
					model: frontmatter.model,
					source,
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

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;

	/**
	 * Find and resolve a model from "provider/model-id" or just "model-id".
	 * If no provider is specified, searches all models by ID.
	 * Prefers models with auth, then by provider priority: anthropic > github-copilot > openrouter.
	 */
	function resolveModel(modelSpec: string, ctx: ExtensionContext): Model<any> | undefined {
		const slashIndex = modelSpec.indexOf("/");

		if (slashIndex !== -1) {
			// Has provider: use exact match
			const provider = modelSpec.slice(0, slashIndex);
			const modelId = modelSpec.slice(slashIndex + 1);

			if (!provider || !modelId) {
				ctx.ui.notify(`Invalid model format "${modelSpec}". Expected "provider/model-id"`, "error");
				return undefined;
			}

			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) {
				ctx.ui.notify(`Model "${modelSpec}" not found`, "error");
				return undefined;
			}
			return model;
		}

		// No provider: search all models by ID
		const allMatches = ctx.modelRegistry.getAll().filter((m) => m.id === modelSpec);

		if (allMatches.length === 0) {
			ctx.ui.notify(`Model "${modelSpec}" not found`, "error");
			return undefined;
		}

		if (allMatches.length === 1) {
			return allMatches[0];
		}

		// Multiple matches - prefer models with auth configured
		const availableMatches = ctx.modelRegistry.getAvailable().filter((m) => m.id === modelSpec);

		if (availableMatches.length === 1) {
			return availableMatches[0];
		}

		if (availableMatches.length > 1) {
			// Multiple with auth - prefer by provider priority
			const preferredProviders = ["anthropic", "github-copilot", "openrouter"];
			for (const provider of preferredProviders) {
				const preferred = availableMatches.find((m) => m.provider === provider);
				if (preferred) {
					return preferred;
				}
			}
			// No preferred provider found, use first available
			return availableMatches[0];
		}

		// No matches with auth - show all options
		const options = allMatches.map((m) => `${m.provider}/${m.id}`).join(", ");
		ctx.ui.notify(`Ambiguous model "${modelSpec}". Options: ${options}`, "error");
		return undefined;
	}

	// Reload prompts on session start (in case cwd changed)
	pi.on("session_start", async (_event, ctx) => {
		prompts = loadPromptsWithModel(ctx.cwd);
	});

	// Restore model after the agent finishes responding
	// This happens immediately after the switched-model response completes
	pi.on("agent_end", async (_event, ctx) => {
		if (previousModel) {
			const modelName = previousModel.id;
			await pi.setModel(previousModel);
			previousModel = undefined;
			ctx.ui.notify(`Restored to ${modelName}`, "info");
		}
	});

	// Initialize: register commands for prompts with model frontmatter
	// This runs at extension load time, so we scan for prompts immediately
	const initialCwd = process.cwd();
	const initialPrompts = loadPromptsWithModel(initialCwd);

	for (const [name, prompt] of initialPrompts) {
		const sourceLabel = prompt.source === "user" ? "(user)" : "(project)";
		const modelLabel = prompt.model.split("/").pop() || prompt.model;

		pi.registerCommand(name, {
			description: prompt.description
				? `${prompt.description} [${modelLabel}] ${sourceLabel}`
				: `[${modelLabel}] ${sourceLabel}`,

			handler: async (args, ctx) => {
				// Re-fetch the prompt in case it was updated
				const currentPrompt = prompts.get(name);
				if (!currentPrompt) {
					ctx.ui.notify(`Prompt "${name}" no longer exists`, "error");
					return;
				}

				// Resolve the model
				const model = resolveModel(currentPrompt.model, ctx);
				if (!model) return;

				// Check if we're already on the target model (skip switch/restore)
				const alreadyOnTargetModel = ctx.model?.provider === model.provider && ctx.model?.id === model.id;

				if (!alreadyOnTargetModel) {
					// Store previous model to restore after response
					previousModel = ctx.model;

					// Switch to the specified model
					const success = await pi.setModel(model);
					if (!success) {
						ctx.ui.notify(`No API key for model "${currentPrompt.model}"`, "error");
						previousModel = undefined;
						return;
					}
				}

				// Expand the template with arguments
				const parsedArgs = parseCommandArgs(args);
				const expandedContent = substituteArgs(currentPrompt.content, parsedArgs);

				// Send the expanded prompt as a user message
				pi.sendUserMessage(expandedContent);
			},
		});
	}
}

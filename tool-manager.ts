import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notify } from "./notifications.ts";

export interface ToolManagerDeps {
	isActive(): boolean;
	getStoredCtx(): ExtensionCommandContext | null;
	setStoredCtx(ctx: ExtensionCommandContext | null): void;
	executeCommand(command: string, ctx: ExtensionCommandContext): Promise<void>;
}

export function createToolManager(pi: ExtensionAPI, deps: ToolManagerDeps) {
	let toolEnabled = false;
	let toolGuidance: string | null = null;
	let toolRegistered = false;
	let toolQueuedCommand: string | null = null;
	const configPath = join(getAgentDir(), "prompt-template-model.json");

	try {
		const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
		if (rawConfig && typeof rawConfig === "object") {
			const config = rawConfig as { toolEnabled?: unknown; toolGuidance?: unknown };
			if (typeof config.toolEnabled === "boolean") {
				toolEnabled = config.toolEnabled;
			}
			if (typeof config.toolGuidance === "string") {
				toolGuidance = config.toolGuidance;
			}
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			process.stderr.write(
				`[pi-prompt-template-model] Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	function saveToolConfig() {
		try {
			mkdirSync(getAgentDir(), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ toolEnabled, toolGuidance }, null, 2));
		} catch (error) {
			process.stderr.write(
				`[pi-prompt-template-model] Failed to write ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	function ensureRegistered() {
		if (toolRegistered) return;
		toolRegistered = true;
		pi.registerTool({
			name: "run-prompt",
			label: "Run Prompt",
			description:
				"Run a prompt template command. Pass the template name and any arguments. " +
				"Supports --loop for loops (e.g. 'deslop --loop 5', 'deslop --loop=5', 'deslop --loop' for unlimited until convergence with a 999-iteration cap), " +
				"--fresh for context collapse between iterations, and --no-converge to disable early stopping for bounded loops. " +
				"Supports runtime delegation override via --subagent, --subagent=<name>, or --subagent:<name>. " +
				"Use 'chain-prompts template1 -> template2' for chaining and add --chain-context to pass previous step summaries into delegated steps.",
			promptSnippet:
				"Use this to run slash/prompt templates by name with args (including --loop/--fresh and chain-prompts flows) when the user asks to execute a prompt template.",
			parameters: Type.Object({
				command: Type.String({
					description: "Template name and arguments (e.g. 'deslop --loop 5 --fresh', 'deslop --subagent:worker', 'deslop --subagent', 'chain-prompts analyze -> fix --chain-context', 'chain-prompts analyze -> fix --loop=3')",
				}),
			}),
			execute: async (_id, params) => {
				if (!toolEnabled) {
					return {
						content: [{ type: "text", text: "run-prompt tool is disabled. User must run `/prompt-tool on` to enable." }],
						details: {},
					};
				}
				if (deps.isActive()) {
					return {
						content: [{ type: "text", text: "A prompt command is already running. Wait for it to complete." }],
						details: {},
					};
				}
				if (!deps.getStoredCtx()) {
					return {
						content: [{ type: "text", text: "No command context. Run any prompt command first to initialize." }],
						details: {},
						isError: true,
					};
				}

				const commandParam = (params as { command?: unknown }).command;
				const command = typeof commandParam === "string" ? commandParam.trim() : "";
				if (!command) {
					return {
						content: [{ type: "text", text: "No command specified." }],
						details: {},
						isError: true,
					};
				}
				if (toolQueuedCommand) {
					return {
						content: [{ type: "text", text: "A prompt command is already queued. Wait for it to execute." }],
						details: {},
						isError: true,
					};
				}

				toolQueuedCommand = command;
				return {
					content: [{ type: "text", text: `Prompt command queued: "${command}". Will execute when this turn ends.` }],
					details: {},
				};
			},
		});
	}

	function registerCommand() {
		pi.registerCommand("prompt-tool", {
			description: "Manage the run-prompt tool (agent-accessible prompt execution)",
			handler: async (args, ctx) => {
				deps.setStoredCtx(ctx);
				const trimmed = args.trim();

				if (trimmed === "on" || trimmed.startsWith("on ")) {
					toolEnabled = true;
					ensureRegistered();
					const guidanceRaw = trimmed.slice("on".length).trim();
					if (guidanceRaw) {
						toolGuidance = guidanceRaw.replace(/^["']|["']$/g, "");
						notify(ctx, `run-prompt tool enabled with guidance: "${toolGuidance}"`, "info");
					} else {
						notify(ctx, "run-prompt tool enabled.", "info");
					}
					saveToolConfig();
					return;
				}

				if (trimmed === "off") {
					toolEnabled = false;
					saveToolConfig();
					notify(ctx, "run-prompt tool disabled.", "info");
					return;
				}

				if (trimmed === "guidance" || trimmed.startsWith("guidance ")) {
					if (trimmed === "guidance" || trimmed === "guidance show") {
						if (toolGuidance) {
							notify(ctx, `Current guidance: "${toolGuidance}"`, "info");
						} else {
							notify(ctx, "No guidance set. Use `/prompt-tool guidance <text>` to set.", "info");
						}
					} else if (trimmed === "guidance clear") {
						toolGuidance = null;
						saveToolConfig();
						notify(ctx, "Guidance cleared.", "info");
					} else {
						const guidanceRaw = trimmed.slice("guidance".length).trim();
						toolGuidance = guidanceRaw.replace(/^["']|["']$/g, "");
						saveToolConfig();
						notify(ctx, `Guidance set: "${toolGuidance}"`, "info");
					}
					return;
				}

				if (!trimmed) {
					if (toolEnabled) {
						const guidanceInfo = toolGuidance ? ` | Guidance: "${toolGuidance}"` : "";
						notify(ctx, `run-prompt tool is enabled${guidanceInfo}`, "info");
					} else {
						notify(ctx, "run-prompt tool is disabled", "info");
					}
					return;
				}

				notify(ctx, "Usage: /prompt-tool [on [guidance] | off | guidance [text|clear]]", "error");
			},
		});
	}

	async function processQueue(ctx: ExtensionContext, restoreFn: () => Promise<void>) {
		if (!toolQueuedCommand) return false;
		const storedCtx = deps.getStoredCtx();
		if (!storedCtx) {
			toolQueuedCommand = null;
			return false;
		}

		const command = toolQueuedCommand;
		toolQueuedCommand = null;
		await restoreFn();
		try {
			await deps.executeCommand(command, storedCtx);
		} catch (error) {
			notify(
				ctx,
				`Failed to execute queued prompt command "${command}": ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		return true;
	}

	return {
		isEnabled() {
			return toolEnabled;
		},
		getGuidance() {
			return toolGuidance;
		},
		clearQueue() {
			toolQueuedCommand = null;
		},
		ensureRegistered,
		registerCommand,
		processQueue,
	};
}

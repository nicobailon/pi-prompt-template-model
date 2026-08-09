import type { Model } from "@earendil-works/pi-ai";
import { substituteArgs } from "./args.ts";
import { getResolvedModelRef, isSameModel, selectModelCandidate, type ModelSelectionOptions, type RegistryLike, type SelectedModelCandidate } from "./model-selection.ts";
import type { PromptWithModel } from "./prompt-loader.ts";
import { renderTemplateConditionals } from "./template-conditionals.ts";

export interface PreparedPromptExecution {
	selectedModel: SelectedModelCandidate;
	content: string;
	warning?: string;
}

export interface EmptyPromptAbort {
	message: string;
	warning?: string;
}

interface PromptExecutionOptions extends ModelSelectionOptions {
	inheritedModel?: Model<any>;
}

export interface RenderedPrompt {
	content?: string;
	warning?: string;
	empty?: string;
}

export function renderPromptForResolvedModel(
	prompt: Pick<PromptWithModel, "name" | "content">,
	args: string[],
	model: Model<any>,
): RenderedPrompt {
	const rendered = renderTemplateConditionals(prompt.content, getResolvedModelRef(model), prompt.name);
	const content = substituteArgs(rendered.content, args);
	if (content.trim().length === 0) {
		return {
			empty: `Prompt \`${prompt.name}\` rendered to an empty message.`,
			warning: rendered.error,
		};
	}
	return {
		content,
		warning: rendered.error,
	};
}

export async function preparePromptExecution(
	prompt: Pick<PromptWithModel, "name" | "content" | "models">,
	args: string[],
	currentModel: Model<any> | undefined,
	modelRegistry: RegistryLike,
	options?: PromptExecutionOptions,
): Promise<PreparedPromptExecution | EmptyPromptAbort | undefined> {
	const selectedModel =
		prompt.models.length === 0
			? (() => {
				const hasInheritedModel = options !== undefined && Object.hasOwn(options, "inheritedModel");
				const inheritedModel = hasInheritedModel ? options.inheritedModel : currentModel;
				if (!inheritedModel) {
					return {
						message: `Prompt \`${prompt.name}\` has no \`model\` configured and there is no active session model to inherit.`,
					};
				}
				return {
					model: inheritedModel,
					alreadyActive: isSameModel(currentModel, inheritedModel),
				};
			})()
			: await selectModelCandidate(prompt.models, currentModel, modelRegistry, options);
	if (!selectedModel) return undefined;
	if ("message" in selectedModel) return selectedModel;

	const rendered = renderPromptForResolvedModel(prompt, args, selectedModel.model);
	if (rendered.empty) {
		return {
			message: rendered.empty,
			warning: rendered.warning,
		};
	}

	return {
		selectedModel,
		content: rendered.content ?? "",
		warning: rendered.warning,
	};
}

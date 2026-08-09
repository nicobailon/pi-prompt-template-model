import type { Model } from "@earendil-works/pi-ai";
import type { ResolvedModelRef } from "./template-conditionals.ts";

const PREFERRED_PROVIDERS = ["openai-codex", "anthropic", "github-copilot", "openrouter"];

export interface SelectedModelCandidate {
	model: Model<any>;
	alreadyActive: boolean;
}

export interface RegistryLike {
	find(provider: string, modelId: string): Model<any> | undefined;
	getAll(): Model<any>[];
	getAvailable(): Model<any>[];
	isUsingOAuth(model: Model<any>): boolean;
	hasConfiguredAuth?: (model: Model<any>) => boolean;
	getApiKeyAndHeaders?: (model: Model<any>) => Promise<{
		ok: boolean;
		apiKey?: string;
		headers?: Record<string, string>;
		error?: string;
	}>;
}

export interface ScopedModelLike {
	model: Model<any>;
}

export interface ModelSelectionOptions {
	scopedModels?: readonly ScopedModelLike[];
}

export function isSameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
	if (!a || !b) return a === b;
	return a.provider === b.provider && a.id === b.id;
}

function modelSpecMatches(modelSpec: string, model: Model<any>): boolean {
	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelSpec.slice(0, slashIndex);
		const modelId = modelSpec.slice(slashIndex + 1);
		return provider === model.provider && modelId === model.id;
	}

	return modelSpec === model.id;
}

function orderMatchesByProviderPreference(models: Model<any>[]): Model<any>[] {
	const prioritized: Model<any>[] = [];
	const seen = new Set<string>();

	for (const provider of PREFERRED_PROVIDERS) {
		for (const model of models) {
			const key = `${model.provider}/${model.id}`;
			if (model.provider === provider && !seen.has(key)) {
				prioritized.push(model);
				seen.add(key);
			}
		}
	}

	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (!seen.has(key)) {
			prioritized.push(model);
			seen.add(key);
		}
	}

	return prioritized;
}

function getScopedModels(options?: ModelSelectionOptions): Model<any>[] | undefined {
	const scopedModels = options?.scopedModels?.map((entry) => entry.model) ?? [];
	return scopedModels.length > 0 ? scopedModels : undefined;
}

function isInScope(model: Model<any>, scopedModels: Model<any>[] | undefined): boolean {
	return !scopedModels || scopedModels.some((candidate) => isSameModel(candidate, model));
}

function getModelCandidates(
	modelSpec: string,
	registry: Pick<RegistryLike, "find" | "getAll">,
	scopedModels: Model<any>[] | undefined,
): Model<any>[] {
	const slashIndex = modelSpec.indexOf("/");

	if (slashIndex !== -1) {
		const provider = modelSpec.slice(0, slashIndex);
		const modelId = modelSpec.slice(slashIndex + 1);
		if (!provider || !modelId) return [];
		if (modelId.split("/").some((segment) => segment.length === 0)) return [];
		const model = registry.find(provider, modelId);
		return model && isInScope(model, scopedModels) ? [model] : [];
	}

	const sourceModels = scopedModels ?? registry.getAll();
	const allMatches = sourceModels.filter((model) => model.id === modelSpec);
	if (allMatches.length <= 1) return allMatches;
	return orderMatchesByProviderPreference(allMatches);
}

async function hasUsableAuth(model: Model<any>, registry: RegistryLike, scopedModels: Model<any>[] | undefined): Promise<boolean> {
	if (isInScope(model, scopedModels) && scopedModels) return true;
	const availableMatch = registry.getAvailable().some((candidate) => isSameModel(candidate, model));
	if (availableMatch) return true;
	if (!registry.isUsingOAuth(model)) return false;
	if (registry.hasConfiguredAuth) return registry.hasConfiguredAuth(model);
	if (registry.getApiKeyAndHeaders) {
		const auth = await registry.getApiKeyAndHeaders(model);
		return auth.ok;
	}
	return false;
}

export async function selectModelCandidate(
	modelSpecs: string[],
	currentModel: Model<any> | undefined,
	registry: RegistryLike,
	options?: ModelSelectionOptions,
): Promise<SelectedModelCandidate | undefined> {
	const scopedModels = getScopedModels(options);
	if (currentModel && isInScope(currentModel, scopedModels) && modelSpecs.some((spec) => modelSpecMatches(spec, currentModel))) {
		return { model: currentModel, alreadyActive: true };
	}

	for (const spec of modelSpecs) {
		for (const model of getModelCandidates(spec, registry, scopedModels)) {
			if (await hasUsableAuth(model, registry, scopedModels)) {
				return { model, alreadyActive: false };
			}
		}
	}

	return undefined;
}

export function getResolvedModelRef(model: Model<any>): ResolvedModelRef {
	return { provider: model.provider, id: model.id };
}

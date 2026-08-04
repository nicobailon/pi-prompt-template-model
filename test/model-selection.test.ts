import test from "node:test";
import assert from "node:assert/strict";
import { selectModelCandidate } from "../model-selection.ts";

interface FakeModel {
	provider: string;
	id: string;
}

function createRegistry(models: FakeModel[], available: FakeModel[] = []) {
	return {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return available;
		},
			async getApiKeyAndHeaders(model: FakeModel) {
				if (available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
					return { ok: true, apiKey: "token" };
				}
				return { ok: false, error: "missing auth" };
			},
		isUsingOAuth() {
			return false;
		},
	};
}

test("selectModelCandidate preserves the current active model before provider preference for bare ids", async () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-20250514" },
		{ provider: "openrouter", id: "claude-sonnet-4-20250514" },
	];
	const registry = createRegistry(models, models);

	const selected = await selectModelCandidate(
		["claude-sonnet-4-20250514"],
		models[1] as never,
		registry as never,
	);

	assert.equal(selected?.alreadyActive, true);
	assert.deepEqual(selected?.model, models[1]);
});

test("selectModelCandidate skips explicit providers without auth before later fallbacks", async () => {
	const models = [
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "openrouter", id: "claude-haiku-4-5" },
	];
	const registry = createRegistry(models, [models[1]]);

	const selected = await selectModelCandidate(
		["anthropic/claude-haiku-4-5", "openrouter/claude-haiku-4-5"],
		undefined,
		registry as never,
	);

	assert.equal(selected?.alreadyActive, false);
	assert.deepEqual(selected?.model, models[1]);
});

test("selectModelCandidate resolves explicit provider specs when the model id contains slashes", async () => {
	const models = [
		{ provider: "openrouter", id: "openai/gpt-5.4" },
	];
	const registry = createRegistry(models, models);

	const selected = await selectModelCandidate(["openrouter/openai/gpt-5.4"], undefined, registry as never);
	assert.deepEqual(selected?.model, models[0]);
	assert.equal(selected?.alreadyActive, false);
});

test("selectModelCandidate rejects explicit provider specs with empty model-id path segments", async () => {
	const models = [
		{ provider: "openrouter", id: "openai/gpt-5.4" },
	];
	const registry = createRegistry(models, models);

	const selected = await selectModelCandidate([
		"/model",
		"provider/",
		"openrouter//gpt",
		"openrouter/gpt/",
	], undefined, registry as never);
	assert.equal(selected, undefined);
});

test("selectModelCandidate prefers available providers for ambiguous bare ids", async () => {
	const models = [
		{ provider: "openrouter", id: "claude-haiku-4-5" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
	];
	const registry = createRegistry(models, models);
	const selected = await selectModelCandidate(["claude-haiku-4-5"], undefined, registry as never);
	assert.deepEqual(selected?.model, models[1]);
	assert.equal(selected?.alreadyActive, false);
});

test("selectModelCandidate can recover an ambiguous bare id through OAuth-style api key lookup", async () => {
	const models = [
		{ provider: "openrouter", id: "claude-haiku-4-5" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "github-copilot", id: "claude-haiku-4-5" },
	];
	const registry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return [];
		},
			async getApiKeyAndHeaders(model: FakeModel) {
				if (model.provider === "github-copilot") {
					return { ok: true, apiKey: "oauth-token" };
				}
				return { ok: false, error: "missing auth" };
			},
		isUsingOAuth(model: FakeModel) {
			return model.provider === "github-copilot";
		},
	};

	const selected = await selectModelCandidate(["claude-haiku-4-5"], undefined, registry as never);
	assert.deepEqual(selected?.model, models[2]);
	assert.equal(selected?.alreadyActive, false);
});

test("selectModelCandidate prefers a higher-priority OAuth-backed provider over a lower-priority immediately available provider", async () => {
	const models = [
		{ provider: "openrouter", id: "claude-haiku-4-5" },
		{ provider: "github-copilot", id: "claude-haiku-4-5" },
	];
	const registry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return [models[0]];
		},
			async getApiKeyAndHeaders(model: FakeModel) {
				if (model.provider === "github-copilot") {
					return { ok: true, apiKey: "oauth-token" };
				}
				return { ok: false, error: "missing auth" };
			},
		isUsingOAuth(model: FakeModel) {
			return model.provider === "github-copilot";
		},
	};

	const selected = await selectModelCandidate(["claude-haiku-4-5"], undefined, registry as never);
	assert.deepEqual(selected?.model, models[1]);
	assert.equal(selected?.alreadyActive, false);
});

test("selectModelCandidate prioritizes openai-codex for ambiguous bare ids", async () => {
	const models = [
		{ provider: "anthropic", id: "gpt-5.2" },
		{ provider: "openai-codex", id: "gpt-5.2" },
		{ provider: "openrouter", id: "gpt-5.2" },
	];
	const registry = createRegistry(models, models);
	const selected = await selectModelCandidate(["gpt-5.2"], undefined, registry as never);
	assert.deepEqual(selected?.model, models[1]);
});

test("selectModelCandidate restricts prompt models to scoped models when present", async () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-20250514" },
		{ provider: "openrouter", id: "claude-sonnet-4-20250514" },
	];
	const registry = createRegistry(models, models);
	const selected = await selectModelCandidate(
		["claude-sonnet-4-20250514"],
		models[0] as never,
		registry as never,
		{ scopedModels: [{ model: models[1] as never }] },
	);

	assert.equal(selected?.alreadyActive, false);
	assert.deepEqual(selected?.model, models[1]);
});

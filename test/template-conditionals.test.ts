import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplateConditionals } from "../template-conditionals.ts";

const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

test("renderTemplateConditionals matches exact provider, bare id, and provider wildcard specs", () => {
	const template = [
		'<if-model is="openai/gpt-5.2">wrong</if-model>',
		'<if-model is="claude-sonnet-4-20250514">bare</if-model>',
		'<if-model is="anthropic/*"> wildcard</if-model>',
	].join("");

	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, "bare wildcard");
	assert.equal(result.error, undefined);
});

test("renderTemplateConditionals matches explicit provider specs whose model ids contain slashes", () => {
	const template = '<if-model is="openrouter/openai/gpt-5.4">match</if-model><if-model is="openrouter/*">fallback</if-model>';
	const result = renderTemplateConditionals(template, { provider: "openrouter", id: "openai/gpt-5.4" }, "demo");
	assert.equal(result.content, "matchfallback");
	assert.equal(result.error, undefined);
});

test("renderTemplateConditionals supports comma-separated lists, nesting, and else branches", () => {
	// Correct syntax: <else> is a separator, no </else> closing tag
	const template = '<if-model is="openai/gpt-5.2, anthropic/*">A<if-model is="claude-sonnet-4-20250514">B</if-model><else>C</if-model>';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, "AB");
});

test("renderTemplateConditionals renders else branch when model does not match", () => {
	// Correct syntax: <else> is a separator, not a container - no </else> needed
	const template = '<if-model is="openai/*">openai<else>not-openai</if-model>';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, "not-openai");
});

test("renderTemplateConditionals injects nothing when no branch matches and no else exists", () => {
	const result = renderTemplateConditionals("before<if-model is=\"openai/gpt-5.2\">inside</if-model>after", model, "demo");
	assert.equal(result.content, "beforeafter");
});

test("renderTemplateConditionals preserves original content and warns on malformed markup", () => {
	const template = '<if-model is="anthropic/*">ok<else extra="nope">bad</if-model>';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.match(result.error ?? "", /Invalid <if-model> markup in prompt `demo`/);
});

test("renderTemplateConditionals rejects invalid wildcard forms", () => {
	const template = '<if-model is="anthropic/claude-*">bad</if-model>';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.match(result.error ?? "", /Invalid model spec/);
});

test("renderTemplateConditionals rejects specs with internal whitespace", () => {
	const template = '<if-model is="anthropic /*">bad</if-model>';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.match(result.error ?? "", /Invalid model spec/);
});

test("renderTemplateConditionals rejects provider-qualified specs with empty path segments", () => {
	const specs = ["/model", "provider/", "openrouter//gpt", "openrouter/gpt/"];
	for (const spec of specs) {
		const template = `<if-model is="${spec}">bad</if-model>`;
		const result = renderTemplateConditionals(template, model, "demo");
		assert.equal(result.content, template);
		assert.match(result.error ?? "", /Invalid model spec/);
	}
});

test("renderTemplateConditionals ignores literal tags that merely share a directive prefix", () => {
	const template = 'literal <elsewhere> and </if-modeling> should survive';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.equal(result.error, undefined);
});

test("renderTemplateConditionals surfaces malformed else tags even without an if-model block", () => {
	const template = '<else extra="nope">';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.match(result.error ?? "", /<else>` cannot have attributes or extra characters/);
});

test("renderTemplateConditionals rejects closing else tags", () => {
	const template = '<if-model is="openai/*">openai<else>not-openai</else></if-model>';
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.match(result.error ?? "", /<\/else>` is not valid/);
});

test("renderTemplateConditionals rejects standalone closing else tags", () => {
	// </else> without any <if-model> should still produce an error
	const template = "some text </else> more text";
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, template);
	assert.match(result.error ?? "", /<\/else>` is not valid/);
});

test("renderTemplateConditionals preserves surrounding whitespace exactly", () => {
	const template = "before\n\n<if-model is=\"openai/gpt-5.2\">x</if-model>\n\nafter\n";
	const result = renderTemplateConditionals(template, model, "demo");
	assert.equal(result.content, "before\n\n\n\nafter\n");
});

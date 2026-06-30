import test from "node:test";
import assert from "node:assert/strict";
import { parseChainDeclaration, parseChainSteps } from "../chain-parser.ts";

test("parseChainDeclaration keeps the first valid per-step --loop and strips repeated loop tokens", () => {
	const parsed = parseChainDeclaration("worker --loop 2 --loop 3");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration strips invalid loop tokens when a later valid loop exists", () => {
	const parsed = parseChainDeclaration("worker --loop 1000 --loop 2");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration keeps quoted --loop tokens as step args", () => {
	const parsed = parseChainDeclaration('worker "--loop" "2"');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: ["--loop", "2"], loopCount: undefined }]);
});

test("parseChainDeclaration parses parallel() groups into parallel steps", () => {
	const parsed = parseChainDeclaration("parallel(scan-fe, scan-be) -> review");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{
			parallel: [
				{ name: "scan-fe", args: [], loopCount: undefined },
				{ name: "scan-be", args: [], loopCount: undefined },
			],
		},
		{ name: "review", args: [], loopCount: undefined },
	]);
});

test("parseChainDeclaration rejects empty parallel() groups", () => {
	const parsed = parseChainDeclaration("parallel() -> review");
	assert.deepEqual(parsed.steps, [{ name: "review", args: [], loopCount: undefined }]);
	assert.deepEqual(parsed.invalidSegments, ["parallel()"]);
});

test("parseChainDeclaration rejects nested parallel() groups", () => {
	const parsed = parseChainDeclaration("parallel(scan-fe, parallel(scan-be, scan-infra)) -> review");
	assert.deepEqual(parsed.steps, [{ name: "review", args: [], loopCount: undefined }]);
	assert.deepEqual(parsed.invalidSegments, ["parallel(scan-fe, parallel(scan-be, scan-infra))"]);
});

test("parseChainSteps splits chain separators outside parallel() groups", () => {
	const parsed = parseChainSteps("parallel(scan-fe --loop 2, scan-be) -> review -- --global --flag");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{
			parallel: [
				{ name: "scan-fe", args: [], loopCount: 2 },
				{ name: "scan-be", args: [], loopCount: undefined },
			],
		},
		{ name: "review", args: [], loopCount: undefined },
	]);
	assert.deepEqual(parsed.sharedArgs, ["--global", "--flag"]);
});

test("parseChainDeclaration parses and strips per-step --with-context", () => {
	const parsed = parseChainDeclaration("worker --with-context");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: undefined, withContext: true }]);
});

test("parseChainDeclaration strips repeated --with-context tokens", () => {
	const parsed = parseChainDeclaration("worker --with-context --with-context");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: undefined, withContext: true }]);
});

test("parseChainDeclaration keeps quoted --with-context as a step arg", () => {
	const parsed = parseChainDeclaration('worker "--with-context"');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: ["--with-context"], loopCount: undefined }]);
});

test("parseChainDeclaration supports --with-context with per-step --loop", () => {
	const parsed = parseChainDeclaration("worker --with-context --loop 2");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2, withContext: true }]);
});

test("parseChainDeclaration treats bare --loop as unlimited per-step loop", () => {
	const parsed = parseChainDeclaration("double-check --loop -> deslop");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{ name: "double-check", args: [], loopCount: null },
		{ name: "deslop", args: [], loopCount: undefined },
	]);
});

test("parseChainDeclaration treats bare --loop with non-numeric next token as unlimited", () => {
	const parsed = parseChainDeclaration("worker --loop --with-context");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: null, withContext: true }]);
});

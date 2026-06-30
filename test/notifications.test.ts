import test from "node:test";
import assert from "node:assert/strict";
import { notify } from "../notifications.ts";

test("notify writes non-UI messages to stderr instead of stdout", () => {
	const writes: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;

	try {
		notify(undefined, "hello", "info");
	} finally {
		process.stderr.write = originalWrite;
	}

	assert.deepEqual(writes, ["hello\n"]);
});

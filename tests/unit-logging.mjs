import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendBridgeLog } from "../src/logging.ts";

test("bridge diagnostics create a missing log directory and append entries", (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-log-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const log = join(root, "agent", "claude-bridge-diag.log");

	assert.equal(appendBridgeLog(log, "first\n"), true);
	assert.equal(appendBridgeLog(log, "second\n"), true);
	assert.equal(readFileSync(log, "utf8"), "first\nsecond\n");
});

test("unwritable bridge diagnostics do not throw", (t) => {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-log-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const unavailableDirectory = join(root, "agent");
	writeFileSync(unavailableDirectory, "not a directory");

	assert.equal(appendBridgeLog(join(unavailableDirectory, "claude-bridge-diag.log"), "diagnostic\n"), false);
});

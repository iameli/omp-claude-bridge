import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mock } from "bun:test";
import { getSessionPath } from "cc-session-io";

const pending = new Map();
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	createSdkMcpServer() { throw new Error("No tools expected in this fixture"); },
	query({ prompt, options }) {
		const gate = Promise.withResolvers();
		let interrupted = false;
		pending.set(prompt, gate);
		const iterator = (async function* () {
			yield { type: "system", subtype: "init", session_id: options.resume ?? randomUUID() };
			await gate.promise;
			if (interrupted) throw new Error("Interrupted");
			yield { type: "result", subtype: "success", result: "Finished" };
		})();
		iterator.close = () => {};
		iterator.interrupt = async () => { interrupted = true; gate.resolve(); };
		return iterator;
	},
}));

const { __test } = await import("../../src/index.ts");
const root = mkdtempSync(join(tmpdir(), "claude-bridge-session-"));
const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });
const history = [user("Deployment target is alpha"), assistant("Remembered alpha")];
const sync = (messages, owner = "main", isolate = false, cwd = root) =>
	__test.syncSharedSession(messages, cwd, undefined, undefined, owner, isolate);
const bytes = (id, cwd = root) => readFileSync(getSessionPath(id, cwd), "utf8");
const stored = (id, cwd = root) => bytes(id, cwd).trim().split("\n").map(JSON.parse)
	.filter((record) => record.type === "user" || record.type === "assistant").map((record) => record.message);
const model = {
	id: "claude-sonnet-4-6", api: "claude-bridge", provider: "claude-bridge", reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

try {
	const first = sync([...history, user("Continue")]);
	assert.deepEqual(stored(first.sessionId).map((message) => message.content), history.map((message) => message.content));
	assert.equal(sync([...history, user("Continue")]).sessionId, first.sessionId);

	// A utility request can leave the cached cursor ahead even when no compact event fired.
	__test.setSharedSession({ ...__test.getSharedSession(), cursor: history.length + 1 });
	const shortened = sync([...history, user("Continue after recap")]);
	assert.equal(shortened.sessionId, first.sessionId);
	assert.deepEqual(stored(shortened.sessionId).map((message) => message.content), history.map((message) => message.content));

	const originalBytes = bytes(first.sessionId);
	const side = sync([...history, user("Recap")], "main:side:1");
	assert.notEqual(side.sessionId, first.sessionId);
	assert.equal(bytes(first.sessionId), originalBytes);
	const resumed = sync([...history, user("Continue")]);
	assert.notEqual(resumed.sessionId, side.sessionId);
	assert.deepEqual(stored(resumed.sessionId).map((message) => message.content), history.map((message) => message.content));

	const activeBytes = bytes(resumed.sessionId);
	const concurrent = sync([...history, user("Concurrent request")], "main", true);
	assert.notEqual(concurrent.sessionId, resumed.sessionId);
	assert.equal(bytes(resumed.sessionId), activeBytes);

	// Identical message counts in different projects must never resume the other project's session.
	const otherProject = mkdtempSync(join(root, "project-"));
	const other = sync([...history, user("Other project")], "main", false, otherProject);
	assert.notEqual(other.sessionId, concurrent.sessionId);
	assert.deepEqual(stored(other.sessionId, otherProject).map((message) => message.content), history.map((message) => message.content));

	const empty = sync([user("Fresh conversation")]);
	assert.equal(empty.sessionId, null);
	assert.equal(__test.getSharedSession(), null);

	// A longer side request completing first must not inflate the main query's cursor.
	const mainMessages = [...history, user("Main query")];
	const mainStream = __test.streamClaudeAgentSdk(model, { messages: mainMessages }, { cwd: root, sessionId: "main" });
	const sideMessages = [...history, user("Extra context"), assistant("Extra reply"), user("Side query")];
	const sideStream = __test.streamClaudeAgentSdk(model, { messages: sideMessages }, { cwd: root, sessionId: "main:side:2" });
	pending.get("Side query").resolve();
	await sideStream.result();
	const completedSide = { ...__test.getSharedSession() };
	pending.get("Main query").resolve();
	await mainStream.result();
	const completedMain = __test.getSharedSession();
	assert.equal(completedMain.ownerId, "main");
	assert.equal(completedMain.cursor, mainMessages.length);
	assert.notEqual(completedMain.sessionId, completedSide.sessionId);
	const next = sync([...mainMessages, assistant("Finished"), user("Next turn")]);
	assert.equal(next.sessionId, completedMain.sessionId);

	// An aborted older query must not invalidate a newer request's cached session.
	const abort = new AbortController();
	const aborted = __test.streamClaudeAgentSdk(model, { messages: [...history, user("Abort me")] }, {
		cwd: root, sessionId: "main", signal: abort.signal,
	});
	const surviving = sync([...history, user("Surviving request")], "main:side:3", true);
	abort.abort();
	assert.equal((await aborted.result()).stopReason, "aborted");
	assert.equal(__test.getSharedSession().sessionId, surviving.sessionId);
	assert.equal(__test.getSharedSession().needsRebuild, undefined);
} finally {
	__test.resetSharedSession();
	if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
	rmSync(root, { recursive: true, force: true });
}

import test from "node:test";
import assert from "node:assert/strict";
import { createSession, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../src/convert.ts";

const calls = (...ids) => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
});
const result = (id, text, isError = false) => ({
	role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError,
});

function replay(messages) {
	const session = createSession({ projectPath: process.cwd() });
	session.importMessages(repairToolPairing(convertPiMessages(messages).anthropicMessages));
	return session.messages.map((record) => record.message);
}

function results(message) {
	return message.content.map((block) => [block.tool_use_id, block.content, Boolean(block.is_error)]);
}

test("replay preserves every parallel result, including errors and out-of-order completion", () => {
	const messages = replay([
		calls("first/1", "second/2", "third/3"),
		result("second/2", "permission denied", true),
		result("first/1", "first file contents"),
		result("third/3", "third file contents"),
	]);
	assert.deepEqual(results(messages[1]), [
		["second_2", "permission denied", true],
		["first_1", "first file contents", false],
		["third_3", "third file contents", false],
	]);
});

test("replay repairs genuinely missing results without merging separate tool batches", () => {
	const messages = replay([
		calls("first", "missing"), result("first", "first batch"),
		calls("next"), result("next", "next batch"),
		{ role: "user", content: "Continue with the next file" },
	]);
	const firstBatch = results(messages[1]);
	assert.deepEqual(firstBatch.map(([id, , failed]) => [id, failed]), [["missing", true], ["first", false]]);
	assert.deepEqual(firstBatch[1], ["first", "first batch", false]);
	assert.deepEqual(results(messages[3]), [["next", "next batch", false]]);
	assert.equal(messages[4].content, "Continue with the next file");
});

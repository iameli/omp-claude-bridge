import assert from "node:assert/strict";
import test from "node:test";
import { PromptCaptures } from "../src/prompt-capture.ts";
import { resolveProviderPromptTransport } from "../src/prompt-transport.ts";

test("uncaptured completeSimple-style request transports its system prompt verbatim", () => {
	const captures = new PromptCaptures();
	const prompt = [
		"You classify request difficulty.",
		"Return exactly one label.",
	].join("\n");

	const result = resolveProviderPromptTransport(captures, prompt, {
		// OMP completeSimple utility calls such as auto-thinking do not carry cwd.
		cwd: undefined,
	});

	assert.deepEqual(result, {
		mode: "verbatim-side-request",
		systemPrompt: prompt,
	});
});

test("explicit agent-attributed side request is verbatim even when it carries cwd", () => {
	const captures = new PromptCaptures();
	const prompt = "Summarize this session for handoff.";

	const result = resolveProviderPromptTransport(captures, prompt, {
		cwd: "/repo",
		initiatorOverride: "agent",
	});

	assert.deepEqual(result, {
		mode: "verbatim-side-request",
		systemPrompt: prompt,
	});
});

test("uncaptured normal coding-agent turn still fails closed", () => {
	const captures = new PromptCaptures();

	assert.throws(
		() =>
			resolveProviderPromptTransport(
				captures,
				"UNACCOUNTED-CODING-AGENT-SYSTEM-PROMPT",
				{ cwd: "/repo" },
			),
		/no capture for this/,
	);
});

test("captured coding-agent turn projects portable content behind Claude Code preset", () => {
	const captures = new PromptCaptures();
	const assembled = "OMP-FULL-HARNESS";
	captures.record(assembled, {
		custom: "PORTABLE-CUSTOM",
		append: "PORTABLE-APPEND",
		contextFiles: [{ path: "/repo/AGENTS.md", content: "PORTABLE-CONTEXT" }],
		skills: [],
	});

	const result = resolveProviderPromptTransport(captures, assembled, {
		cwd: "/repo",
	});

	assert.equal(result.mode, "agent-preset");
	assert.ok(result.append?.includes("PORTABLE-CUSTOM"));
	assert.ok(result.append?.includes("PORTABLE-APPEND"));
	assert.ok(result.append?.includes("PORTABLE-CONTEXT"));
	assert.ok(!result.append?.includes("OMP-FULL-HARNESS"));
});

test("known capture remains projected when reused by a side request", () => {
	const captures = new PromptCaptures();
	const assembled = "KNOWN-AGENT-PROMPT";
	captures.record(assembled, {
		custom: "SAFE-PORTABLE",
		contextFiles: [],
		skills: [],
	});

	const result = resolveProviderPromptTransport(captures, assembled, {});

	assert.equal(result.mode, "agent-preset");
	assert.equal(result.append, "SAFE-PORTABLE");
});

test("side request with no system prompt stays a bare utility completion", () => {
	const captures = new PromptCaptures();

	assert.deepEqual(resolveProviderPromptTransport(captures, undefined, {}), {
		mode: "verbatim-side-request",
		systemPrompt: undefined,
	});
});

test("OMP native advisor uses its own prompt verbatim despite cwd and no capture", () => {
	const captures = new PromptCaptures();
	captures.record("PRIMARY-AGENT-HARNESS", { custom: "MAIN-CUSTOM", contextFiles: [], skills: [] });
	const prompt = "ADVISOR-SYSTEM-PROMPT";
	const result = resolveProviderPromptTransport(captures, prompt, {
		cwd: "/repo",
		nativeAdvisor: true,
	});
	assert.deepEqual(result, { mode: "verbatim-side-request", systemPrompt: prompt });
	assert.equal(captures.size, 1);
});

test("OMP native advisor does not project even if its prompt matches an agent capture", () => {
	const captures = new PromptCaptures();
	captures.record("ADVISOR-SYSTEM-PROMPT", { custom: "INAPPROPRIATE-PROJECTION", contextFiles: [], skills: [] });
	const result = resolveProviderPromptTransport(captures, "ADVISOR-SYSTEM-PROMPT", {
		cwd: "/repo", nativeAdvisor: true,
	});
	assert.deepEqual(result, { mode: "verbatim-side-request", systemPrompt: "ADVISOR-SYSTEM-PROMPT" });
});

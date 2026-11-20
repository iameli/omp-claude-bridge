import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { AdviseTool } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { AdvisorEmissionGuard } from "@oh-my-pi/pi-coding-agent/advisor/emission-guard";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { __test, registerBridge, registerBridgeFromHost } from "../src/index.ts";
import { buildModels } from "../src/models.ts";
import { isNativeAdvisorContext } from "../src/native-advisor.ts";
import {
	compactWithCompleteImpl,
	projectAskClaudeContext,
	stringEnum,
} from "../src/omp-18-compat.ts";
import { PROMPT_CAPTURES_KEY, PromptCaptures, deriveCaptureInput, projectPromptCapture } from "../src/prompt-capture.ts";
import { resolveProviderPromptTransport } from "../src/prompt-transport.ts";
import { defaultHarnessBlock } from "./fixtures/omp-system-prompts.mjs";

const theme = {
	fg: (_color, value) => value,
	bold: (value) => value,
};

function catalogModel(id, contextWindow = 1_000_000) {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text", "image"],
		contextWindow,
		maxTokens: 128_000,
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	};
}

function fakeExtensionApi() {
	const handlers = new Map();
	const providers = [];
	const tools = [];
	return {
		api: {
			typebox,
			pi: codingAgent,
			on(event, handler) {
				const values = handlers.get(event) ?? [];
				values.push(handler);
				handlers.set(event, values);
			},
			registerProvider(name, config) {
				providers.push({ name, config });
			},
			registerTool(tool) {
				tools.push(tool);
			},
		},
		handlers,
		providers,
		tools,
	};
}

test("injected OMP surfaces register the provider and AskClaude renderer/schema", async () => {
	const fake = fakeExtensionApi();
	const models = buildModels([
		catalogModel("claude-opus-5"),
		catalogModel("claude-haiku-4-5", 200_000),
	]);

	registerBridge(fake.api, models, {});

	assert.equal(fake.providers.length, 1);
	assert.equal(fake.providers[0].name, "claude-bridge");
	assert.deepEqual(
		fake.providers[0].config.models.map(({ id, contextWindow }) => ({ id, contextWindow })),
		[
			{ id: "claude-haiku-4-5", contextWindow: 200_000 },
			{ id: "claude-opus-5", contextWindow: 1_000_000 },
		],
	);

	assert.equal(fake.tools.length, 1);
	const askClaude = fake.tools[0];
	assert.equal(typeof askClaude.name, "string");
	assert.ok(askClaude.name.length > 0, "AskClaude tool name is registered");
	const schema = askClaude.parameters.toJsonSchema();
	assert.deepEqual(schema.properties.mode.enum, ["read", "full", "none"]);
	assert.deepEqual(schema.properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

	const callView = askClaude.renderCall({ prompt: "Review this" }, {}, theme);
	const resultView = askClaude.renderResult(
		{ content: [{ type: "text", text: "Looks good" }], details: { executionTime: 1000 } },
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.ok(callView instanceof codingAgent.Text);
	assert.ok(resultView instanceof codingAgent.Text);

	for (const handler of fake.handlers.get("session_shutdown") ?? []) await handler({});
});

test("schema enum construction uses the injected TypeBox facade", () => {
	const schema = stringEnum(typebox.Type, ["one", "two"], "choice").toJsonSchema();
	assert.deepEqual(schema, { enum: ["one", "two"], type: "string", description: "choice" });
});

test("every extension bind refreshes the host catalogue before provider registration", async () => {
	const parent = fakeExtensionApi();
	const child = fakeExtensionApi();
	let reads = 0;
	const readHostModels = () => {
		reads++;
		return [catalogModel(reads === 1 ? "claude-opus-5" : "claude-opus-5-1")];
	};

	registerBridgeFromHost(parent.api, readHostModels, {});
	registerBridgeFromHost(child.api, readHostModels, {});

	assert.equal(reads, 2);
	assert.deepEqual(parent.providers[0].config.models.map(model => model.id), ["claude-opus-5"]);
	assert.deepEqual(child.providers[0].config.models.map(model => model.id), ["claude-opus-5-1"]);

	for (const handler of child.handlers.get("session_shutdown") ?? []) await handler({});
	for (const handler of parent.handlers.get("session_shutdown") ?? []) await handler({});
});

test("compaction takeover preserves the custom completeImpl call shape", async () => {
	const preparation = { marker: "preparation" };
	const model = { marker: "model" };
	const signal = new AbortController().signal;
	const completeImpl = () => Promise.resolve({ marker: "message" });
	let args;
	const fakeCompact = (...received) => {
		args = received;
		return Promise.resolve({ summary: "summary" });
	};

	const result = await compactWithCompleteImpl(
		preparation,
		model,
		"instructions",
		signal,
		completeImpl,
		fakeCompact,
	);

	assert.deepEqual(result, { summary: "summary" });
	assert.equal(args[0], preparation);
	assert.equal(args[1], model);
	assert.equal(args[2], undefined);
	assert.equal(args[3], "instructions");
	assert.equal(args[4], signal);
	assert.equal(args[5].completeImpl, completeImpl);
});

test("OMP's handoff strategy keeps the native summarizer", async () => {
	const fake = fakeExtensionApi();
	registerBridge(fake.api, buildModels([catalogModel("claude-opus-5")]), {});
	try {
		const [beforeCompact] = fake.handlers.get("session_before_compact");
		const result = await beforeCompact({
			preparation: { settings: { strategy: "handoff" } },
		}, { model: { baseUrl: "claude-bridge" } });
		assert.equal(result, undefined);
	} finally {
		for (const handler of fake.handlers.get("session_shutdown") ?? []) await handler({});
	}
});

test("AskClaude session projection uses the host buildSessionContext result exactly", () => {
	const branch = [{ type: "message", id: "entry" }];
	const messages = [{ role: "user", content: "hello" }];
	let received;
	const buildSessionContext = value => {
		received = value;
		return { messages, ignored: true };
	};

	assert.equal(projectAskClaudeContext(false, branch, buildSessionContext), messages);
	assert.equal(received, branch);
	received = undefined;
	assert.equal(projectAskClaudeContext(true, branch, buildSessionContext), undefined);
	assert.equal(received, undefined);
});

test("runtime host imports stay on the canonical OMP compatibility boundary", () => {
	const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const compatSource = readFileSync(new URL("../src/omp-18-compat.ts", import.meta.url), "utf8");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

	assert.doesNotMatch(indexSource, /@oh-my-pi\/pi-coding-agent\//);
	assert.doesNotMatch(indexSource, /from ["']@oh-my-pi\/pi-tui/);
	assert.doesNotMatch(indexSource, /legacy-pi-ai-shim/);
	assert.match(compatSource, /from "@oh-my-pi\/pi-ai"/);
	assert.match(compatSource, /from "@oh-my-pi\/pi-agent-core\/compaction"/);
	for (const name of [
		"@oh-my-pi/pi-agent-core",
		"@oh-my-pi/pi-ai",
		"@oh-my-pi/pi-catalog",
		"@oh-my-pi/pi-coding-agent",
		"@oh-my-pi/pi-tui",
		"@oh-my-pi/pi-utils",
	]) {
		assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, name);
		assert.equal(pkg.devDependencies[name], pkg.devDependencies["@oh-my-pi/pi-coding-agent"], name);
		assert.equal(pkg.dependencies[name], undefined, `${name} must not be a runtime dependency`);
	}
});

for (const [layout, override] of [
	["default", {}],
	["literal", { resolvedCustomPrompt: "CUSTOM-POLICY" }],
	["template", { systemPromptTemplate: "CUSTOM-POLICY" }],
]) {
	test(`real OMP ${layout} prompt preserves context and append exactly once`, async () => {
		const cwd = process.cwd();
		const { systemPrompt } = await buildSystemPrompt({
			cwd,
			contextFiles: [{ path: `${cwd}/AGENTS.md`, content: "PROJECT-POLICY" }],
			resolvedAppendSystemPrompt: "APPEND-POLICY",
			skills: [{ name: "bridge", description: "SKILL-POLICY", filePath: `${cwd}/SKILL.md`, baseDir: cwd, source: "project" }],
			alwaysApplyRules: [{ name: "always", path: `${cwd}/always.md`, content: "GENERIC-POLICY" }],
			rules: [{ name: "domain", description: "DOMAIN-POLICY", path: `${cwd}/domain.md`, globs: ["src/**"] }],
			...override,
		});
		const input = deriveCaptureInput(systemPrompt);
		const projected = projectPromptCapture({ ...input, assembledPrompt: systemPrompt.join("\n\n"), inherited: [] });
		const sentinels = ["PROJECT-POLICY", "APPEND-POLICY"];
		if (layout === "default") {
			assert.equal(input.custom, undefined);
			sentinels.push("SKILL-POLICY", "GENERIC-POLICY", "DOMAIN-POLICY");
		} else {
			sentinels.push("CUSTOM-POLICY");
		}
		assert.ok(projected);
		for (const sentinel of sentinels) assert.equal(projected.split(sentinel).length - 1, 1, sentinel);
	});
}

test("the OMP host's bundled advisor prompt and advise tool select verbatim transport", () => {
	const hostEntry = import.meta.resolve("@oh-my-pi/pi-coding-agent");
	const systemPrompt = readFileSync(new URL("./prompts/advisor/system.md", hostEntry), "utf8");
	const advise = new AdviseTool(() => {}, new AdvisorEmissionGuard({ budgetPerUpdate: 1 }));
	const context = { systemPrompt: [systemPrompt, "WATCHDOG-POLICY"], tools: [advise] };
	const nativeAdvisor = isNativeAdvisorContext(context);
	assert.equal(nativeAdvisor, true);
	assert.deepEqual(resolveProviderPromptTransport(new PromptCaptures(), context.systemPrompt.join("\n\n"), {
		cwd: process.cwd(), nativeAdvisor,
	}), { mode: "verbatim-side-request", systemPrompt: context.systemPrompt.join("\n\n") });
});

test("a subagent session shutdown leaves the parent's prompt capture usable", async () => {
	// OMP 18.2.8 re-binds this already-imported module for subagent sessions
	// (sdk.ts `preloadedPreparedExtensions`, fed by task/executor.ts), so both
	// binds share one streamSimple and one capture registry.
	const parent = fakeExtensionApi();
	const subagent = fakeExtensionApi();
	const models = buildModels([catalogModel("claude-opus-5")]);
	registerBridge(parent.api, models, {});
	registerBridge(subagent.api, models, {});

	// The parent's user turn traverses before_agent_start (agent-session.ts
	// #prepareAgentStart); an automatic continuation later will not.
	const blocks = [
		defaultHarnessBlock({ generation: "18.2.8" }),
		'PROJECT\n\n<repo-rules>\nMUST follow these context files for all tasks:\n<file path="/repo/AGENTS.md">\nPARENT-CONTEXT\n</file>\n</repo-rules>\n\n<critical>\n- Each response MUST advance the task; completion only stopping condition.\ngenerated\n</critical>\n\nPARENT-APPEND',
	];
	for (const handler of parent.handlers.get("before_agent_start") ?? []) {
		await handler({ systemPrompt: blocks }, {});
	}

	for (const handler of subagent.handlers.get("session_shutdown") ?? []) await handler({}, {});

	assert.equal(globalThis[PROMPT_CAPTURES_KEY], __test.promptCaptures());
	const transport = resolveProviderPromptTransport(__test.promptCaptures(), blocks.join("\n\n"), {
		cwd: "/repo",
	});
	assert.equal(transport.mode, "agent-preset");
	assert.match(transport.append, /PARENT-CONTEXT/);
	assert.match(transport.append, /PARENT-APPEND/);

	for (const handler of parent.handlers.get("session_shutdown") ?? []) await handler({}, {});
	assert.equal(globalThis[PROMPT_CAPTURES_KEY], undefined, "the last shutdown unpublishes the registry");
	assert.equal(__test.promptCaptures().size, 0, "the next session starts from an empty registry");
});

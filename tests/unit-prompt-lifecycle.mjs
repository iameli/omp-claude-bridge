// OMP 18.2.8 session-lifecycle regression coverage for prompt transport.
//
// `src/index.ts` cannot be imported under Node (it pulls the Bun-only OMP host
// packages), so this fixture reproduces its lifecycle wiring line for line over
// the real shared-ownership primitives. `tests/omp-18-compat.test.mjs` covers
// the same sequence through `registerBridge()` itself on a real OMP host.
//
// Modelled OMP 18.2.8 invariants (paths under packages/coding-agent/src at tag
// v18.2.8):
//
//  - One extension module evaluation serves several sessions. A subagent
//    re-binds the already-imported factory through `preloadedPreparedExtensions`
//    rather than re-evaluating the module graph (`sdk.ts` extension-load path 2,
//    fed by `task/executor.ts`). So every session in a run shares one
//    `streamSimple` identity and one module-level capture registry, and only the
//    `ExtensionAPI` differs — which is what `moduleInstance()` below models.
//  - `before_agent_start` is emitted only from `#prepareAgentStart()`
//    (`session/agent-session.ts`), i.e. only on the queued/user-prompt path.
//  - The todo tracker appends a `role: "developer"` reminder and calls
//    `scheduleAgentContinue({ source: "todo-reminder" })`
//    (`session/todo-tracker.ts`); `#runAgentContinue()` then reaches
//    `agent.continue(signal)` (`session/agent-session.ts`). That path never
//    calls `#prepareAgentStart()`, so the continuation's provider call carries
//    the agent loop's `cwd` with no fresh `before_agent_start`.
//  - Disposing any session — subagent sessions included — emits
//    `session_shutdown` to that session's extension runner
//    (`session/agent-session.ts` dispose).

import assert from "node:assert/strict";
import test from "node:test";
import {
	PROMPT_CAPTURES_KEY,
	deriveCaptureInput,
	projectPromptCapture,
	releaseSharedPromptCaptures,
	sharedPromptCaptures,
} from "../src/prompt-capture.ts";
import {
	ACTIVE_STREAM_SIMPLE_KEY,
	registerSharedProvider,
	releaseSharedProvider,
} from "../src/provider-registration.ts";
import { resolveProviderPromptTransport } from "../src/prompt-transport.ts";
import { defaultHarnessBlock } from "./fixtures/omp-system-prompts.mjs";

const CWD = "/worktree/root";

/**
 * One evaluation of the extension module, as OMP's loader produces per run.
 * `streamSimple` is module-level in `src/index.ts`, so every session bound from
 * this instance shares it; the capture registry is resolved through the process
 * global on every use, exactly as `src/index.ts` does, so a module instance
 * never keeps writing into a registry that a release has unpublished.
 */
function moduleInstance(globalState) {
	const streamSimple = () => undefined;
	const captures = () => sharedPromptCaptures(globalState);
	const registrations = [];

	return {
		captures,
		registrations,
		/** `registerBridge()` running against one session's ExtensionAPI. */
		bindSession() {
			registerSharedProvider({
				providerId: "claude-bridge",
				streamSimple,
				config: { apiKey: "not-used", api: "claude-bridge" },
				registerProvider: (providerId, config) => registrations.push({ providerId, config }),
				globalState,
			});
			return {
				beforeAgentStart(blocks) {
					captures().record(blocks.join("\n\n"), deriveCaptureInput(blocks));
				},
				sessionShutdown() {
					if (releaseSharedProvider(globalState)) {
						releaseSharedPromptCaptures(captures(), globalState);
					}
				},
				providerCall(systemPrompt, options) {
					return resolveProviderPromptTransport(captures(), systemPrompt, options);
				},
			};
		},
	};
}

/**
 * Synthetic assembled prompt for lifecycle/capture testing.
 *
 * The harness block is a representative OMP default harness only so the capture
 * derives the same shape a real turn does; what this file asserts is capture
 * ownership across sessions, not harness recognition (see unit-prompt-harness.mjs).
 */
function assembledPrompt(marker) {
	const harness = defaultHarnessBlock({ generation: "18.2.6", skills: [`- bridge: SKILL-${marker}`] });
	const project = [
		"PROJECT",
		"",
		"<repo-rules>",
		"MUST follow these context files for all tasks:",
		`<file path="${CWD}/AGENTS.md">`,
		`CONTEXT-${marker}`,
		"</file>",
		"</repo-rules>",
		"",
		"<critical>",
		"- Each response MUST advance the task; completion only stopping condition.",
		"generated project policy",
		"</critical>",
		"",
		`APPEND-${marker}`,
	].join("\n");
	return [harness, project];
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("a todo-reminder continuation survives a subagent shutdown mid-turn", () => {
	const globalState = {};
	const instance = moduleInstance(globalState);
	const main = instance.bindSession();
	// task/executor.ts spawns the subagent against this same module instance.
	const subagent = instance.bindSession();

	const blocks = assembledPrompt("MAIN");
	main.beforeAgentStart(blocks);

	// The subagent finishes and disposes while the main turn is still running.
	subagent.sessionShutdown();

	// todo-reminder → agent.continue(): established session prompt, agent-loop
	// cwd, and no fresh before_agent_start for this provider call.
	const transport = main.providerCall(blocks.join("\n\n"), { cwd: CWD });

	assert.equal(transport.mode, "agent-preset");
	assert.equal(occurrences(transport.append, "CONTEXT-MAIN"), 1);
	assert.equal(occurrences(transport.append, "SKILL-MAIN"), 1);
	assert.equal(occurrences(transport.append, "APPEND-MAIN"), 1);
});

test("a subagent shutdown leaves the parent session's capture registry published", () => {
	const globalState = {};
	const instance = moduleInstance(globalState);
	const main = instance.bindSession();
	const subagent = instance.bindSession();
	main.beforeAgentStart(assembledPrompt("MAIN"));

	subagent.sessionShutdown();

	assert.equal(instance.captures().size, 1, "the parent still needs these captures");
	assert.equal(
		globalState[PROMPT_CAPTURES_KEY],
		instance.captures(),
		"a later extension bind must still find the live registry",
	);
	assert.equal(
		globalState[ACTIVE_STREAM_SIMPLE_KEY],
		instance.registrations[0].config.streamSimple,
		"the parent-owned streamSimple stays registered",
	);
});

test("the last bound session's shutdown still releases provider and capture state", () => {
	const globalState = {};
	const instance = moduleInstance(globalState);
	const main = instance.bindSession();
	const subagent = instance.bindSession();
	main.beforeAgentStart(assembledPrompt("MAIN"));

	subagent.sessionShutdown();
	main.sessionShutdown();

	assert.equal(globalState[PROMPT_CAPTURES_KEY], undefined, "the last shutdown unpublishes the registry");
	assert.equal(instance.captures().size, 0, "and the next bind starts from an empty one");
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], undefined);
});

test("a fresh run cannot inherit a released run's prompt", () => {
	const globalState = {};
	const first = moduleInstance(globalState);
	const firstSession = first.bindSession();
	firstSession.beforeAgentStart(assembledPrompt("GONE"));
	const releasedRegistry = first.captures();
	firstSession.sessionShutdown();

	const second = moduleInstance(globalState);
	const secondSession = second.bindSession();

	assert.notEqual(second.captures(), releasedRegistry, "the released registry is not handed to the next run");
	assert.throws(
		() => secondSession.providerCall(assembledPrompt("GONE").join("\n\n"), { cwd: CWD }),
		/no capture for this/,
	);
});

test("an unexplained coding-agent prompt still fails closed while sessions are live", () => {
	const globalState = {};
	const instance = moduleInstance(globalState);
	const main = instance.bindSession();
	instance.bindSession();
	main.beforeAgentStart(assembledPrompt("MAIN"));

	assert.throws(
		() => main.providerCall("REWRITTEN-BY-A-LATER-EXTENSION", { cwd: CWD }),
		/no capture for this/,
	);
});

test("side requests keep transporting their exact prompt verbatim", () => {
	const globalState = {};
	const instance = moduleInstance(globalState);
	const main = instance.bindSession();
	instance.bindSession();
	main.beforeAgentStart(assembledPrompt("MAIN"));

	assert.deepEqual(main.providerCall("Classify this request.", { cwd: undefined }), {
		mode: "verbatim",
		systemPrompt: "Classify this request.",
	});
	assert.deepEqual(
		main.providerCall("Summarize for handoff.", { cwd: CWD, initiatorOverride: "agent" }),
		{ mode: "verbatim", systemPrompt: "Summarize for handoff." },
	);
});

test("a subagent's own captured prompt stays resolvable after its session ends", () => {
	const globalState = {};
	const instance = moduleInstance(globalState);
	const main = instance.bindSession();
	const subagent = instance.bindSession();
	const subagentBlocks = assembledPrompt("SUBAGENT");
	subagent.beforeAgentStart(subagentBlocks);

	subagent.sessionShutdown();

	// The parent-owned provider callback still serves in-flight subagent work.
	const transport = main.providerCall(subagentBlocks.join("\n\n"), { cwd: CWD });
	assert.equal(transport.mode, "agent-preset");
	assert.equal(occurrences(transport.append, "CONTEXT-SUBAGENT"), 1);
	assert.ok(projectPromptCapture(instance.captures().resolve(subagentBlocks.join("\n\n"))));
});

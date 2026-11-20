import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Same bundled catalogue the extension reads at runtime: the legacy pi-ai
// shim's getModels() is an alias of pi-catalog's getBundledModels().
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

import {
	buildModels,
	buildRegisteredModels,
	claudeCodeModelId,
	compareRevisions,
	isSupportedClaudeModel,
	mapReasoningToClaudeEffort,
	parseClaudeModelId,
	resolveModel,
} from "../src/models.ts";

const catalogEntry = (id, overrides = {}) => ({
	id,
	name: id,
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
	// Source routing fields that must NOT survive projection.
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	...overrides,
});

// --- Structural id parsing ---

test("parseClaudeModelId parses family and multi-part revisions", () => {
	assert.deepEqual(parseClaudeModelId("claude-opus-5"), { family: "opus", revision: [5] });
	assert.deepEqual(parseClaudeModelId("claude-fable-5-1"), { family: "fable", revision: [5, 1] });
	assert.deepEqual(parseClaudeModelId("claude-sonnet-4-6"), { family: "sonnet", revision: [4, 6] });
});

test("parseClaudeModelId rejects non-Claude, legacy, and snapshot ids", () => {
	assert.equal(parseClaudeModelId("gpt-5"), null);
	assert.equal(parseClaudeModelId("claude"), null);
	// Legacy claude-3-* ids put the version before the family.
	assert.equal(parseClaudeModelId("claude-3-5-sonnet-20241022"), null);
	// Dated snapshots duplicate their alias entry.
	assert.equal(parseClaudeModelId("claude-haiku-4-5-20251001"), null);
	assert.equal(parseClaudeModelId("claude-opus-4-20250514"), null);
	// Runtime-only [1m] ids are never catalogue ids.
	assert.equal(parseClaudeModelId("claude-fable-5[1m]"), null);
});

test("isSupportedClaudeModel accepts any canonical family from the Anthropic catalogue shape", () => {
	for (const id of [
		"claude-opus-5",
		"claude-fable-5-1",
		"claude-mythos-5",
		"claude-mythos-5-1",
		"claude-haiku-4-5",
		"claude-opus-4-1",
		"claude-aurora-7-2",
	]) {
		assert.equal(isSupportedClaudeModel(id), true, id);
	}
});

test("isSupportedClaudeModel rejects only non-canonical/legacy/snapshot ids", () => {
	for (const id of [
		"gpt-6",
		"claude",
		"claude-3-5-sonnet-20241022",
		"claude-opus-4-5-20251101",
		"claude-mythos-latest",
		"claude-opus-5[1m]",
	]) {
		assert.equal(isSupportedClaudeModel(id), false, id);
	}
});

// --- Revision ordering ---

test("compareRevisions orders numerically, not lexicographically", () => {
	assert.ok(compareRevisions([5], [4, 8]) > 0);
	assert.ok(compareRevisions([5, 1], [5]) > 0);
	assert.ok(compareRevisions([5, 10], [5, 2]) > 0);
	assert.ok(compareRevisions([5, 10], [5, 9]) > 0);
	assert.ok(compareRevisions([4, 8], [5]) < 0);
	assert.equal(compareRevisions([5], [5, 0]), 0);
});

// --- Discovery over a synthetic catalogue ---

const SYNTHETIC_CATALOG = [
	catalogEntry("claude-opus-4-7"),
	catalogEntry("claude-mythos-5"),
	catalogEntry("claude-opus-5"),
	catalogEntry("claude-haiku-4-5", { contextWindow: 200_000, maxTokens: 64_000 }),
	catalogEntry("claude-fable-5"),
	catalogEntry("claude-haiku-4-5-20251001", { contextWindow: 200_000 }),
	catalogEntry("claude-opus-4-8"),
	catalogEntry("claude-opus-4-5"),
	catalogEntry("claude-fable-5-1"),
	catalogEntry("claude-sonnet-5"),
	catalogEntry("claude-3-5-sonnet-20241022"),
];

test("buildModels accepts catalogue families dynamically and sorts newest revision first per family", () => {
	assert.deepEqual(buildModels(SYNTHETIC_CATALOG).map((m) => m.id), [
		"claude-fable-5-1",
		"claude-fable-5",
		"claude-haiku-4-5",
		"claude-mythos-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-5",
		"claude-sonnet-5",
	]);
});

test("partial names resolve to the newest revision; exact ids stay exact", () => {
	const models = buildModels(SYNTHETIC_CATALOG);
	assert.equal(resolveModel(models, "opus").id, "claude-opus-5");
	assert.equal(resolveModel(models, "fable").id, "claude-fable-5-1");
	assert.equal(resolveModel(models, "claude-fable-5").id, "claude-fable-5");
	assert.equal(resolveModel(models, "haiku").id, "claude-haiku-4-5");
	assert.equal(resolveModel(models, "mythos").id, "claude-mythos-5");
});

test("a synthetic later revision and entirely new family are discovered without source edits", () => {
	const models = buildModels([
		...SYNTHETIC_CATALOG,
		catalogEntry("claude-fable-5-2"),
		catalogEntry("claude-opus-5-1"),
		catalogEntry("claude-aurora-1"),
	]);
	assert.equal(resolveModel(models, "fable").id, "claude-fable-5-2");
	assert.equal(resolveModel(models, "opus").id, "claude-opus-5-1");
	assert.equal(resolveModel(models, "aurora").id, "claude-aurora-1");
});

test("projection preserves catalogue metadata and drops source routing fields", () => {
	const [model] = buildModels([catalogEntry("claude-opus-5", { name: "Claude Opus 5" })]);
	assert.equal(model.name, "Claude Opus 5");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 128_000);
	assert.deepEqual(model.thinking, { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true });
	// Subscription billing: costs are zeroed, never copied.
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	for (const field of ["api", "provider", "baseUrl", "compat"]) {
		assert.equal(field in model, false, field);
	}
});

// --- Discovery over the real OMP catalogue ---

test("current Anthropic catalogue families, including Mythos, are discovered without a bridge allowlist", () => {
	const catalog = getBundledModels("anthropic");
	const models = buildModels(catalog);
	const ids = models.map((m) => m.id);

	for (const id of [
		"claude-fable-5-1",
		"claude-fable-5",
		"claude-mythos-5-1",
		"claude-mythos-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-6",
		"claude-sonnet-5",
		"claude-sonnet-4-6",
		"claude-haiku-4-5",
	]) {
		assert.ok(ids.includes(id), `missing current catalogue model ${id}`);
	}
	for (const id of ids) {
		assert.ok(!/\d{4,}/.test(id), `snapshot id leaked: ${id}`);
	}

	const byVersion = new Intl.Collator("en", { numeric: true });
	for (const family of ["fable", "mythos", "opus"]) {
		const newest = ids.filter((id) => id.startsWith(`claude-${family}-`)).sort(byVersion.compare).at(-1);
		assert.equal(resolveModel(models, family).id, newest, family);
	}

	// Discovery preserves catalogue metadata verbatim; the registered window is
	// that same catalogue capacity (see buildRegisteredModels).
	for (const id of ["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5"]) {
		const registered = models.find((m) => m.id === id);
		const catalogModel = catalog.find((m) => m.id === id);
		assert.equal(registered.contextWindow, catalogModel.contextWindow, id);
		assert.equal(registered.maxTokens, catalogModel.maxTokens, id);
		assert.deepEqual(registered.thinking, catalogModel.thinking, id);
	}
});

test("real catalogue: every current model registers its authoritative context window under its canonical id", () => {
	// Source of truth: OMP's bundled Anthropic catalogue. If OMP corrects a window
	// upstream, the bridge follows automatically — these values are asserted, not
	// hardcoded into src.
	const EXPECTED = {
		"claude-fable-5-1": 1_000_000,
		"claude-fable-5": 1_000_000,
		"claude-mythos-5-1": 1_000_000,
		"claude-mythos-5": 1_000_000,
		"claude-opus-5": 1_000_000,
		"claude-opus-4-8": 1_000_000,
		"claude-opus-4-7": 1_000_000,
		"claude-opus-4-6": 1_000_000,
		"claude-sonnet-5": 1_000_000,
		"claude-sonnet-4-6": 1_000_000,
		"claude-haiku-4-5": 200_000,
	};
	const registered = Object.fromEntries(
		buildRegisteredModels(buildModels(getBundledModels("anthropic"))).map((m) => [m.id, m]),
	);
	for (const [id, window] of Object.entries(EXPECTED)) {
		assert.ok(registered[id], `${id} is registered`);
		assert.equal(registered[id].contextWindow, window, `${id} registers ${window}`);
		assert.equal(claudeCodeModelId(registered[id]), id, `${id} keeps its canonical CLI id`);
	}
});

test("future revisions and future families remain dynamic with no allowlist in source", () => {
	const source = readFileSync(new URL("../src/models.ts", import.meta.url), "utf8");
	assert.ok(!source.includes("SUPPORTED_FAMILIES"));
	assert.ok(!source.includes("claude-fable-5-2"));
	assert.ok(!source.includes("claude-opus-5-1"));
	assert.ok(!source.includes("claude-aurora-1"));
});

// --- Context-window resolution for dynamically discovered models -------------

test("future model regression: a newly discovered 1M model registers as 1M with its canonical id, no source edits", () => {
	// A future revision OMP adds to its catalogue — its id appears nowhere in
	// src/models.ts. It must inherit its catalogue window and canonical CLI id
	// purely through discovery: if this ever requires an exact-id override, the
	// architectural bug has returned and this test fails.
	const future = catalogEntry("claude-opus-5-99", { name: "Claude Opus 5.99", contextWindow: 1_000_000, maxTokens: 128_000 });
	assert.ok(!readFileSync(new URL("../src/models.ts", import.meta.url), "utf8").includes("claude-opus-5-99"));

	const models = buildModels([future]);
	assert.equal(models.length, 1, "discovered: YES");
	const registered = buildRegisteredModels(models);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].id, "claude-opus-5-99", "registered id");
	assert.equal(registered[0].contextWindow, 1_000_000, "registered context");
	assert.equal(claudeCodeModelId(registered[0]), "claude-opus-5-99", "CLI id");
});

test("future model regression: a newly discovered 200K model registers as 200K, no exact-id logic", () => {
	const future = catalogEntry("claude-haiku-4-9", { name: "Claude Haiku 4.9", contextWindow: 200_000, maxTokens: 64_000 });
	const registered = buildRegisteredModels(buildModels([future]));
	assert.equal(registered.length, 1);
	assert.equal(registered[0].id, "claude-haiku-4-9");
	assert.equal(registered[0].contextWindow, 200_000);
	assert.equal(claudeCodeModelId(registered[0]), "claude-haiku-4-9");
});

test("each discovered model registers exactly one canonical entry, never -1m/-200k variants", () => {
	const models = buildModels([catalogEntry("claude-fable-5-2"), catalogEntry("claude-fable-5")]);
	const registered = buildRegisteredModels(models);
	assert.deepEqual(registered.map((m) => m.id), ["claude-fable-5-2", "claude-fable-5"]);
	for (const m of registered) {
		assert.ok(!m.id.endsWith("-1m") && !m.id.endsWith("-200k"), `${m.id} is canonical`);
		assert.equal(claudeCodeModelId(m), m.id);
	}
});

test("a discovered model whose catalogue omits a context window is dropped, not guessed", () => {
	const models = buildModels([catalogEntry("claude-opus-5-98", { contextWindow: null })]);
	assert.equal(models.length, 1, "still discovered structurally");
	assert.equal(buildRegisteredModels(models).length, 0, "but not registered without a window");
});

// --- Model-aware reasoning effort mapping ---

test("real xhigh tiers stay distinct from max", () => {
	const modern = catalogEntry("claude-opus-5", {
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	});
	assert.equal(mapReasoningToClaudeEffort(modern, "xhigh"), "xhigh");
	assert.equal(mapReasoningToClaudeEffort(modern, "max"), "max");

	const fable51 = catalogEntry("claude-fable-5-1", {
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	});
	assert.equal(mapReasoningToClaudeEffort(fable51, "xhigh"), "xhigh");
	assert.equal(mapReasoningToClaudeEffort(fable51, "max"), "max");
});

test("legacy models without a real xhigh tier retain the max fallback", () => {
	const opus46 = catalogEntry("claude-opus-4-6", {
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"] },
	});
	assert.equal(mapReasoningToClaudeEffort(opus46, "xhigh"), "max");
});

test("thinking effortMap is honored before sending the wire effort", () => {
	const mapped = catalogEntry("claude-opus-5", {
		thinking: {
			mode: "anthropic-adaptive",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			effortMap: { xhigh: "high" },
		},
	});
	assert.equal(mapReasoningToClaudeEffort(mapped, "xhigh"), "high");
});

test("dynamic context safety: a discovered model's registered window equals its catalogue capacity", () => {
	// The catalogue is the single source of truth: whatever window OMP advertises
	// is what the bridge registers, verbatim, for MYOMP's context-fit router.
	const oneMillion = buildRegisteredModels(buildModels([catalogEntry("claude-opus-6", { contextWindow: 1_000_000 })]));
	assert.equal(oneMillion.length, 1);
	assert.equal(oneMillion[0].contextWindow, 1_000_000);
	assert.equal(claudeCodeModelId(oneMillion[0]), "claude-opus-6");

	const smaller = buildRegisteredModels(buildModels([catalogEntry("claude-opus-6", { contextWindow: 128_000 })]));
	assert.equal(smaller[0].contextWindow, 128_000);
});

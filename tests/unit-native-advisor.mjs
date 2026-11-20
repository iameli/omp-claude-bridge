import assert from "node:assert/strict";
import test from "node:test";
import { isNativeAdvisorContext } from "../src/native-advisor.ts";

const nativePrompt = "User, code-quality, robustness advocate; peer-shadow main agent.\n- Sharpen strategy.";

test("OMP native advisor is identified from its tool and built-in prompt", () => {
	assert.equal(isNativeAdvisorContext({
		systemPrompt: [nativePrompt, "WATCHDOG instructions"], tools: [{ name: "advise" }, { name: "read" }],
	}), true);
	assert.equal(isNativeAdvisorContext({
		systemPrompt: nativePrompt, tools: [{ name: "advise" }],
	}), true);
});

test("the OMP 18 advisor conventions preamble preserves native advisor recognition", () => {
	const systemPrompt = [
		"<conventions>",
		"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`.",
		"</conventions>",
		"",
		nativePrompt,
	].join("\n");
	assert.equal(isNativeAdvisorContext({ systemPrompt, tools: [{ name: "advise" }] }), true);
	assert.equal(isNativeAdvisorContext({ systemPrompt, tools: [{ name: "read" }] }), false);
	assert.equal(isNativeAdvisorContext({ systemPrompt: `Unrelated prompt\n\n${systemPrompt}`, tools: [{ name: "advise" }] }), false);
});

test("missing tool or wrong prompt cannot bypass prompt capture", () => {
	assert.equal(isNativeAdvisorContext({ systemPrompt: nativePrompt, tools: [{ name: "read" }] }), false);
	assert.equal(isNativeAdvisorContext({ systemPrompt: "User custom instructions", tools: [{ name: "advise" }] }), false);
	assert.equal(isNativeAdvisorContext({ systemPrompt: undefined, tools: [{ name: "advise" }] }), false);
});

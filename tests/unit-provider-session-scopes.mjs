import assert from "node:assert/strict";
import test from "node:test";
import { ProviderSessionScopes } from "../src/provider-session-scopes.ts";

test("primary and native advisor maintain independent Claude Code session state", () => {
	const scopes = new ProviderSessionScopes();
	const main = scopes.forRequest(false, "primary-uuid");
	const advisor = scopes.forRequest(true, "advisor-uuid");
	main.current = { sessionId: "cc-main", cursor: 12 };
	advisor.current = { sessionId: "cc-advisor", cursor: 4 };
	assert.notEqual(main, advisor);
	assert.deepEqual(scopes.forRequest(false, "another-id").current, { sessionId: "cc-main", cursor: 12 });
	assert.deepEqual(scopes.forRequest(true, "advisor-uuid").current, { sessionId: "cc-advisor", cursor: 4 });
	advisor.current = { sessionId: "cc-advisor", cursor: 8 };
	assert.equal(main.current.cursor, 12);
});

test("independent concurrent advisor identities and lifecycle reset", () => {
	const scopes = new ProviderSessionScopes();
	const a = scopes.forRequest(true, "advisor-A");
	const b = scopes.forRequest(true, "advisor-B");
	a.current = { sessionId: "cc-A" };
	b.current = { sessionId: "cc-B" };
	assert.notEqual(a, b);
	assert.equal(scopes.forRequest(true, "advisor-A").current.sessionId, "cc-A");
	assert.equal(scopes.forRequest(true, "advisor-B").current.sessionId, "cc-B");
	scopes.reset();
	assert.equal(scopes.primary.current, null);
	assert.equal(scopes.forRequest(true, "advisor-A").current, null);
});

test("unidentified advisor cannot fall back to and contaminate primary session", () => {
	const scopes = new ProviderSessionScopes();
	assert.throws(() => scopes.forRequest(true), /must provide a distinct/);
	assert.throws(() => scopes.forRequest(true, ""), /must provide a distinct/);
	assert.equal(scopes.primary.current, null);
});

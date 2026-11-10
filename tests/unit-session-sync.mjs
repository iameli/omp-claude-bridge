import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Importing the provider loads OMP's Bun-only runtime; keep the ordinary suite on Node.
test("provider session replay and request ownership regressions", () => {
	execFileSync("bun", [fileURLToPath(new URL("./fixtures/session-sync.mjs", import.meta.url))], {
		encoding: "utf8",
		timeout: 30_000,
	});
});

// Bun discovers only *.test/*_test files by default. Keep the historical
// unit-*.mjs files importable by Node while giving `bun test` one stable entry.
import "./unit-askclaude-thinking.mjs";
import "./unit-context-window.mjs";
import "./unit-debug-reasoning.mjs";
import "./unit-logging.mjs";
import "./unit-model-discovery.mjs";
import "./unit-prompt-append.mjs";
import "./unit-prompt-capture.mjs";
import "./unit-prompt-harness.mjs";
import "./unit-prompt-lifecycle.mjs";
import "./unit-prompt-transport.mjs";
import "./unit-provider-registration.mjs";
import "./unit-rate-limit.mjs";
import "./unit-tool-availability.mjs";
import "./unit-tool-schema.mjs";
// Cross-version Zod matrix: kept out of the `unit-*` glob (it loads four pinned
// Zod copies) but part of the default `bun test` run.
import "./crossversion-zod-wire-schema.mjs";

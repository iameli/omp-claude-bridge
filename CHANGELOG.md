# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Debug-mode reasoning instrumentation: provider and AskClaude calls now log a
  dedicated `reasoning-map` record showing the OMP-requested reasoning level,
  the mapped Claude Agent SDK effort, and the effective Claude Code model id.
- Fully dynamic Claude model discovery from OMP's Anthropic catalogue. The
  picker has no hard-coded model-id **or family** allowlist: canonical
  `claude-<family>-<revision>` aliases are discovered structurally, dated
  snapshots/legacy ids are skipped, and catalogue metadata (context window,
  max tokens, thinking/effort capabilities) is preserved verbatim. New
  revisions and entirely new families therefore appear without a bridge source
  edit; Mythos 5/5.1 from OMP 18.2.2 are regression-covered examples.
- Runtime context smoke probe: `bun run smoke:context` sends a tiny request to
  the newest model in every discovered family and compares Claude Code's
  served `modelUsage.contextWindow` with OMP's catalogue. Models that are
  catalogued but unavailable to the authenticated account are reported as
  `UNAVAILABLE` and skipped; actual window mismatches, missing usage metadata,
  and unexpected errors still fail the smoke. `--all` probes every registered
  model; explicit ids can be supplied for targeted checks.
- AskClaude's public `thinking` parameter now accepts `max`, alongside `off`,
  `minimal`, `low`, `medium`, `high`, and `xhigh`. The value flows through the
  existing model-aware `mapReasoningToClaudeEffort` mapper (no AskClaude-side
  remap), so model-specific `max`/`xhigh` fallbacks are preserved.

### Fixed
- A reviewer or other live agent can now send a prompt that OMP rebuilt after
  `before_agent_start`. The bridge verifies it against the effective prompt of
  the same session and forwards it verbatim, preserving later instructions.
- Prompt projection on OMP 19 now recognizes its generated default harness and
  `<project-context>` footer, preserving repository context, rules, skills and
  append instructions. Native advisor recognition also accepts the conventions
  preamble used by OMP 18 without relaxing the required `advise` tool check.
- OMP 19's native `/handoff` keeps its own summarization path. Its one-shot
  Claude Code request uses a separate session slot while the primary turn runs.
- User append instructions (`APPEND_SYSTEM.md` / `--append-system-prompt`) being
  silently dropped whenever OMP rendered block 0 from `SYSTEM_TEMPLATE.md` or
  `--system-prompt-template`. `deriveCaptureInput()` read the append from the
  PROJECT footer only when block 0 was *not* portable custom text, on the
  assumption that any custom block already carries its own append. That holds
  only for the literal routes: OMP v18.2.8 `system-prompt.ts` folds
  `appendPrompt` into block 0 via `custom-system-prompt.md` — and blanks the
  footer's `contextFiles`/`appendPrompt` — only when `resolvedCustomPrompt` is
  set, which the template routes leave undefined. A rendered template is
  therefore portable custom text *and* keeps its append in the PROJECT footer,
  so the bridge captured the template but no append, and Claude Code never saw
  the user's instructions. The append is now read from the rendered PROJECT
  footer on every layout, following OMP's actual output structure instead of
  inferring append ownership from block 0. Plain `SYSTEM.md` cannot duplicate:
  its footer tail is empty by construction, so the extractor finds nothing to
  add beside the copy already inside `custom`. No content-based deduplication is
  performed — a template that intentionally renders `{{appendPrompt}}` itself
  keeps both copies OMP emitted.
- OMP's generated default system harness being forwarded on top of Claude Code's
  own `claude_code` preset on OMP >= 18.2.7. `src/prompt-capture.ts` recognized
  the generated block 0 by a literal `<conventions>` opening plus the role
  sentence `Helpful, trusted assistant for load-bearing changes …`. OMP 18.2.7
  rewrote the top of `prompts/system/system-prompt.md`: the `<conventions>`
  wrapper is gone (the RFC 2119 line now opens the block) and the role sentence
  became `You are a helpful, trusted assistant working in Oh My Pi coding
  harness.` Neither marker matched, so `extractCustomPromptBlock()` treated the
  whole generated harness as portable custom text — a real 18.2.8 turn projected
  an 18320-char append behind a 19171-char assembled prompt, duplicating OMP's
  harness — and, because the default append is only read from the PROJECT tail
  when block 0 is *not* custom, the user's `--append-system-prompt` /
  `APPEND_SYSTEM.md` text was dropped entirely. Recognition is now a small table
  of known harness generations (opening line + `§ Role` sentence) combined with
  the ordered spine of unconditional `§` sections (`§ Runtime`, `§ Tool Policy`,
  `§ Workflow`, `§ Delivery`, `§ Critical`), which has been stable since v17.2.15.
  Requiring all of them keeps a user's own prompt out of the harness class even
  when it quotes OMP prose. Verified against real renderings from OMP v18.2.8 and
  against the v18.2.2/v18.2.6 layout; the same turn now projects 402 chars of
  context + skills + append and no harness. A block rendered from
  `custom-system-prompt.md` is rejected outright, so a `SYSTEM.md` that pastes a
  copy of the bundled harness keeps its own additions. The generated default
  harness's `<generic-rules>` and `<domain-rules>` containers are captured as
  portable rule blocks before the harness is stripped, projected after skills,
  and deduplicated across prompt inheritance; this preserves always-apply rule
  bodies and the domain-rule catalogue instead of losing them on OMP >= 18.2.7.
  Domain-rule projection also carries OMP's `rule://<name>` loading instruction,
  so the catalogue retains its intended lookup semantics.
  Rule extraction is gated on a recognized default harness, so a genuine custom
  prompt that happens to use the same XML-like tags remains byte-faithful.
  Releases up to v18.1.20, which opened with `<system-conventions>`, are still
  unrecognized — that generation never matched the previous marker either.
- `prompt-capture: no capture for this N-char system prompt, and it embeds none
  of the 0 known` on OMP 18.2.8 automatic continuations (notably the todo
  completion reminder). Two lifecycle facts combined: OMP emits
  `before_agent_start` only from `AgentSession#prepareAgentStart()`, so
  `TodoTracker.checkCompletion()` → `scheduleAgentContinue({source:
  "todo-reminder"})` → `#runAgentContinue()` → `agent.continue()` reaches the
  provider with the agent loop's `cwd` but no fresh capture; and OMP re-binds a
  single extension module evaluation for subagent sessions
  (`preloadedPreparedExtensions`), so the parent session and every subagent
  shared one `streamSimple` object. The bridge keyed provider-stream ownership
  on that object's identity, so the first subagent `session_shutdown` passed the
  ownership check and cleared the process-global prompt-capture registry while
  the parent turn was still running — leaving the continuation with `0 known`
  captures and failing the turn closed. Ownership is now a count of bound
  sessions: shared state is released only when the last one shuts down. The
  capture registry is also resolved through the process global per use instead
  of being snapshotted at module evaluation, so a module instance can no longer
  keep recording into a registry that has been unpublished.
- OMP-native tools reaching a `claude-bridge` turn. The bridge exposes OMP's
  tools through an in-process MCP server, and the Claude Agent SDK renders that
  server's `tools/list` with its own bundled Zod (4.4.3) while the schemas are
  built with whichever Zod the host installed for the plugin — `zod@^4` floats,
  and OMP's plugin install resolves 4.6.5. `_zod.processJSONSchema` and
  `_zod.parent` already exist in 4.4.3, so this is not a general "Zod >= 4.5"
  incompatibility: the break is one processor. From **Zod 4.5.3** the record
  JSON Schema processor requires `ctx.deferred` on the conversion context, and
  4.4.3's `initializeContext()` does not allocate that field, so a
  `z.record(...)` built by a host Zod >= 4.5.3 throws
  `ctx.deferred.push` inside the SDK's walker. Claude Code drops *every* tool of
  a server whose `tools/list` fails, so one object-typed parameter (bash's `env`) took
  the whole `mcp__custom-tools__*` namespace off the turn: `task` and the rest
  were reported by the model as nonexistent and OMP fell back to direct
  execution. Each property now pins the JSON Schema OMP already declared
  (`_zod.toJSONSchema`), which both Zod builds consult before dispatching to any
  processor, so the rendering no longer depends on the two versions agreeing
  (regression-tested through a real SDK MCP server against pinned host Zod
  4.4.3/4.5.2/4.5.3/4.6.5, the committed matrix: 4.5.2 is the last version the
  unpinned path renders on, 4.5.3 and 4.6.5 throw without the pin, and all four
  succeed with it). This gives exact *property-level* preservation —
  every property whose schema is a plain JSON object, and the `required` list,
  are emitted as OMP declared them, including property-level `anyOf`, `default`,
  `enum` and values in data positions — but not byte-for-byte preservation of
  the root schema, since `createSdkMcpServer` still rebuilds the top-level
  object wrapper, drops root-level keywords (`additionalProperties` on every OMP
  18.2.6 tool, plus a root `description` on `todo`) and adds its own `$schema`,
  exactly as before this change. Property schemas that cannot be pinned safely
  degrade to a permissive `{}` and are reported rather than throwing: a
  sub-schema that is not a plain JSON object (JSON Schema allows `true`/`false`,
  and malformed input can hold any JSON value), a cyclic or otherwise
  non-JSON-safe schema, or excessive nesting — both traversals are
  depth-bounded, so neither can throw a `RangeError` out of the provider turn.
  An unresolved `$ref` *keyword* is dropped (its target `$defs` lives on the
  root the SDK rebuilds) while a property legitimately *named* `$ref` is
  preserved, since map members are property names rather than keywords.
- Silent loss of the whole OMP tool surface. A server that fails `tools/list`
  still reports itself `connected`, so the bridge now compares the tools Claude
  Code advertises at `init` against the ones it registered and reports the
  difference (debug log, OMP notification, diagnostic dump) instead of running
  the turn toolless. Repeats of the same condition are deduplicated across
  continuation/replay queries; a different missing set reports again, and a
  healthy init clears the memory so a later failure is never suppressed.
  `createSdkMcpServer` is now called with `alwaysLoad: true`, which keeps OMP's
  tools out of Claude Code's Tool Search deferral — both so they always reach
  the turn and so the advertised list stays a sound signal for this detector.
  Tool names are compared exactly first, then case-insensitively when exactly
  one registered name folds to that key, matching `mapToolName` elsewhere in the
  bridge without ever letting one advertised spelling vouch for two distinct
  registered names.
- Faithful system-prompt transport. The provider previously replaced OMP's
  assembled system prompt with Claude Code's `claude_code` preset plus only
  AGENTS.md and the skills block, so a subagent's native `task.context` (e.g. a
  MYOMP sequential-decomposition child's `PRIOR_PHASE_RESULTS`) never reached
  Claude Code. The bridge now records each assembled prompt at
  `before_agent_start` and derives portable content from the exact rendered
  `systemPrompt[]` instead of re-discovering files from `process.cwd()`: rendered
  context files (with paths), skills, default-layout append text, custom-prompt
  user/project content, and the subagent role/context block are projected behind
  Claude Code's preset exactly once. The process-global capture registry lets a
  child record under one extension instance and resolve from the parent-owned
  provider callback, and is cleared only when that provider owner shuts down.
  Unknown prompts fail closed instead of silently dropping instructions. See
  [`src/prompt-capture.ts`](src/prompt-capture.ts).

### Changed
- Upgraded `@anthropic-ai/claude-agent-sdk` to `^0.3.274`, whose bundled Claude
  Code runtime is 2.1.274, so newly promoted Fable 5.1 works without requiring
  a separate system CLI override. Companion Anthropic/MCP/Zod dependencies are
  aligned with the SDK's current peer requirements; `pathToClaudeCodeExecutable`
  remains available as an explicit override.
- Context windows are now resolved entirely from OMP's Anthropic catalogue.
  Each discovered model is registered with the catalogue's canonical
  `contextWindow` verbatim and its canonical id is sent to Claude Code
  unchanged. This corrects stale metadata — Opus 5, Sonnet 5, Fable 5, Opus 4.6,
  and Sonnet 4.6 now register their true **1M** window instead of a 200K/`[1m]`
  approximation — and means a newly discovered revision or family inherits its
  window automatically, with no bridge source edit. Mythos 5/5.1 register at 1M
  directly from OMP 18.2.2; Haiku 4.5 stays 200K. MYOMP's context-fit decisions
  and OMP's status bar / auto-compaction now read catalogue capacities. Any
  runtime/catalogue mismatch reported by Claude Code is surfaced once to the
  user and can be reproduced with `bun run smoke:context`.
- `resolveModel` prefers an exact id match over partial containment, so an
  exact id never resolves to a newer revision containing it as a prefix.
- Thinking metadata is now projected from the catalogue into registration, and
  the effort table understands the new top `max` tier.
- `@oh-my-pi/*` devDependencies bumped to ^18.2.2 so typecheck/tests run
  against the same catalogue as current OMP installs (peer ranges unchanged).

### Removed
- Exact-id context-window machinery: `RUNTIME_OVERRIDE_IDS` and the
  `resolveAuto`/`resolveForcedOneM`/`resolveForcedTwoHundredK`/`availableOverrideRuntimes`/
  `resolveDynamicRuntimeModel` resolvers, the `[1m]` model-id spelling, and the
  synthetic `-1m`/`-200k` picker variants (`buildVariantModels`, `parseVariantId`).
  Every supported model has one canonical window, so there is nothing to select.
- `provider.contextWindow`, `provider.plan`, and `provider.longContextExtraUsage`.
  None affected true model capability once windows became catalogue-driven; the
  first two also risked misreporting capacity. Setting any of them now logs a
  one-time deprecation notice and is otherwise ignored. `plan`/`longContextExtraUsage`
  remain valid Anthropic billing concepts but never redefine a model's context window.

## [0.8.1] - 2026-07-07

### Fixed
- Spurious "Claude rate limit warning" toasts at trivial utilization. The Claude
  Agent SDK emits `allowed_warning` rate-limit events even at ~1% of the
  `seven_day` (weekly) limit; these are now surfaced only at ≥80% utilization.
  Hard-limit (`rejected`) notifications and the debug log are unchanged.

## [0.8.0] - 2026-07-07

### Added
- On-demand context-window variants in the `/model` picker: each model is now
  registered once per window it supports (1M and/or 200K) as a distinct,
  clearly-labeled entry (e.g. `Opus 4.8 (1M)` and `Opus 4.8 (200K)`). Switching
  a model's context window is a picker selection instead of a config edit plus
  reload.
- Suffixed model ids (`<model>-1m` / `<model>-200k`) that force a specific
  window regardless of the global default — usable from `modelRoles` and
  AskClaude short names. The unsuffixed id remains the config default, so
  existing `config.yml` roles keep working.

### Changed
- `provider.contextWindow` now sets the **default** window (which window the
  unsuffixed model id maps to) instead of hiding models that don't match it.
  Both windows stay pickable wherever a runtime exists.
- Each variant reports its true `contextWindow`, keeping the status bar and
  auto-compaction accurate for the selected window.

## [0.7.0] - 2026-07-06

First public release of the Oh My Pi port.

### Added
- `provider.contextWindow` setting with three modes:
  - `"auto"` (default) — per-model context policy based on measured SDK behavior.
  - `"1m"` — force the 1M context window; only 1M-capable models are registered.
  - `"200k"` — force the 200K context window; only 200K-capable models are registered.
- Models without a runtime for the selected forced window are hidden from the
  model picker instead of being misreported.
- `thinkingLevelMap` fallback so Sonnet 5 / Sonnet 4.6 expose `xhigh` (mapped to `max`).

### Changed
- Ported from Pi (`@earendil-works/*`) to Oh My Pi (`@oh-my-pi/*`): extension
  manifest (`omp.extensions`), provider registration, message conversion, and
  config directory resolution (`~/.omp/agent/claude-bridge.json`).
- Corrected the `claude-fable-5` context policy: the bare `claude-fable-5`
  runtime serves 200K (verified), while `claude-fable-5[1m]` serves 1M. In
  `"auto"` mode Fable 5 now registers at 200K.

### Credits
- Original `pi-claude-bridge` by [Eli Dickinson](https://github.com/elidickinson).
- Oh My Pi port and context-window controls by [Jonathan Borgwing](https://github.com/DevVig).

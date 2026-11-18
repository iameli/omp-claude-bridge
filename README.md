<div align="center">

<img src="assets/banner.svg" alt="omp-claude-bridge — Run Claude Code natively inside Oh My Pi" width="100%" />

<h1>omp-claude-bridge</h1>

<p><strong>Run Claude Code as a first-class model provider inside <a href="https://omp.sh">Oh My Pi</a> — with an AskClaude delegation tool and accurate per-model context windows.</strong></p>

<p>
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
<img alt="Oh My Pi extension" src="https://img.shields.io/badge/Oh%20My%20Pi-extension-6E56CF">
<img alt="Claude Agent SDK" src="https://img.shields.io/badge/Claude%20Code-Agent%20SDK-D97757">
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
<a href="https://github.com/DevVig/omp-claude-bridge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/DevVig/omp-claude-bridge/actions/workflows/ci.yml/badge.svg"></a>
<img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

</div>

---

`omp-claude-bridge` lets you drive **Claude Code** — Opus, Sonnet, Haiku, and Fable — from inside Oh My Pi, with every tool call flowing through OMP's native TUI. It also exposes an **AskClaude** tool so any other provider can delegate a task or a second opinion to Claude Code, and it registers each model with the **canonical context window** OMP's catalogue reports for it, so OMP's status bar, context-usage math, and model-switch safety stay accurate.

Authentication and billing run through Claude Code and your Anthropic subscription via the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) — this extension never stores credentials.

<div align="center">
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</div>

## Table of contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Context windows](#context-windows)
- [Models](#models)
- [AskClaude tool](#askclaude-tool)
- [Configuration reference](#configuration-reference)
- [How it works](#how-it-works)
- [Debugging](#debugging)
- [Development](#development)
- [Credits](#credits)
- [License](#license)

## Features

- **Claude Code as a provider** — pick Opus / Sonnet / Haiku / Fable from `/model`; tool calls render in OMP's TUI like any native provider.
- **AskClaude delegation tool** — from any other provider, hand a task or question to Claude Code (read-only, no-tools, or full read/write/bash), optionally in an isolated session.
- **Accurate per-model context windows** — each model is registered with its canonical context capacity straight from OMP's Anthropic catalogue (e.g. Opus 5 and Sonnet 5 at 1M, Haiku 4.5 at 200K), so OMP never under- or over-reports a model's real limit.
- **Session resume & persistence** — conversations survive across turns and reconnects.
- **Faithful system-prompt transport** — Claude Code keeps its native `claude_code` preset; the bridge projects OMP's *portable* additions (context files, skills, custom/append text, and a subagent's role/assignment context including native `task.context`) behind it, without duplicating OMP's harness. Unaccountable prompts fail closed rather than silently dropping instructions.
- **Thinking support** — effort levels map through to Claude Code, including `xhigh` on Sonnet models.
- **MCP tool bridging** with strict-config isolation by default.

## Install

```bash
omp plugin install git:github.com/DevVig/omp-claude-bridge
```

<details>
<summary>Other install methods</summary>

```bash
# From the full HTTPS URL
omp plugin install https://github.com/DevVig/omp-claude-bridge

# From a local checkout (great for hacking on it)
git clone https://github.com/DevVig/omp-claude-bridge.git
omp plugin install ./omp-claude-bridge
```

</details>

Requires Oh My Pi (`omp`) and a working Claude Code login.

## Quickstart

1. Install the plugin (above).
2. In OMP, run `/model` and choose a `claude-bridge/*` model — for example `claude-bridge/claude-sonnet-5`.
3. Work as usual. Tool calls run through OMP's TUI; Claude Code handles the model turn.

To delegate from another provider instead, just ask: *"Ask Claude to review this plan and poke holes in it."*

## Context windows

Every Claude model has one canonical context window, and the bridge registers it straight from **OMP's Anthropic model catalogue** — the same metadata OMP uses everywhere else. There is no exact-id override table, no synthetic `-1m` / `-200k` picker variants, and no `[1m]` model-id spelling: the canonical model id is sent to Claude Code unchanged, and the registered `contextWindow` is the catalogue's value verbatim.

With the current catalogue that means, for example:

| Picker id | Registered window | Source |
| --------- | ----------------- | ------ |
| `claude-bridge/claude-opus-5` | 1M | OMP catalogue |
| `claude-bridge/claude-sonnet-5` | 1M | OMP catalogue |
| `claude-bridge/claude-opus-4-8` | 1M | OMP catalogue |
| `claude-bridge/claude-opus-4-7` | 1M | OMP catalogue |
| `claude-bridge/claude-opus-4-6` | 1M | OMP catalogue |
| `claude-bridge/claude-fable-5-1` | 1M | OMP catalogue |
| `claude-bridge/claude-fable-5` | 1M | OMP catalogue |
| `claude-bridge/claude-mythos-5-1` | 1M | OMP catalogue |
| `claude-bridge/claude-mythos-5` | 1M | OMP catalogue |
| `claude-bridge/claude-sonnet-4-6` | 1M | OMP catalogue |
| `claude-bridge/claude-haiku-4-5` | 200K | OMP catalogue |

Because discovery and context metadata are both data-driven, a newer revision **or an entirely new canonical Claude family** is registered from the Anthropic catalogue automatically after restart — no bridge source edit or family allowlist change required.

### Runtime capability metadata

The Claude Agent SDK exposes **no pre-flight context-window capability API**: `query.supportedModels()` returns display/effort metadata but no context window. Historical `context-1m-2025-08-07` beta behavior is therefore not used as a capability table. Registration uses the current OMP catalogue / Anthropic capability metadata as the source of truth, while the runtime smoke probe validates what Claude Code actually serves for the authenticated account.

> The window Claude Code actually *serves* is still read from each result's `modelUsage`. A mismatch with the catalogue is surfaced as a one-time runtime warning and written to the debug log. Before relying on very large contexts after a Claude Code/SDK update, run `bun run smoke:context`: it sends a tiny prompt to the newest model in every discovered family and compares the served window with OMP's catalogue. Models catalogued by OMP but unavailable to the authenticated account (for example invite-only Mythos without entitlement) are reported as `UNAVAILABLE` and skipped; `MISMATCH`, `NO_USAGE`, and unexpected errors remain failures. Use `bun run smoke:context -- --all` to probe every registered model, or append explicit model ids.

## Models

The picker is **discovered dynamically from OMP's Anthropic model catalogue** — there is no hard-coded model-id or family allowlist to update when Anthropic ships a new model. The bridge:

1. reads OMP's Anthropic catalogue at startup (synchronously, no network);
2. keeps canonical `claude-<family>-<revision>` aliases and skips dated snapshots / legacy version-before-family ids;
3. orders families deterministically and each family newest-revision-first, so a partial name like `opus` always resolves to the newest Opus;
4. preserves the catalogue metadata — including each model's canonical `contextWindow` — and registers it directly, with no exact-id capability table.

When your installed OMP catalogue gains a new revision **or a new family**, it appears in `/model` automatically after restart with its catalogue context window. Mythos is a concrete regression case: OMP 18.2.2 already catalogues Mythos 5/5.1, and the bridge now discovers them without adding `"mythos"` anywhere in source. Availability is account-specific: Anthropic marks Mythos as invite-only/trusted-access, so catalogued models can legitimately appear in the picker yet be rejected by Claude Code for an account without entitlement.

With the current OMP catalogue you get, e.g.:

| Picker id | Window |
| --------- | ------ |
| `claude-bridge/claude-fable-5-1` | 1M |
| `claude-bridge/claude-fable-5` | 1M |
| `claude-bridge/claude-mythos-5-1` | 1M |
| `claude-bridge/claude-mythos-5` | 1M |
| `claude-bridge/claude-opus-5` | 1M |
| `claude-bridge/claude-opus-4-8` | 1M |
| `claude-bridge/claude-opus-4-7` | 1M |
| `claude-bridge/claude-opus-4-6` | 1M |
| `claude-bridge/claude-sonnet-5` | 1M |
| `claude-bridge/claude-sonnet-4-6` | 1M |
| `claude-bridge/claude-haiku-4-5` | 200K (cheapest) |

Fable 5.1 requires Claude Code 2.1.251 or newer. If the Claude Code bundled with your installed Agent SDK is older, point `provider.pathToClaudeCodeExecutable` at a current stable CLI path such as `~/.local/bin/claude`.

Bash commands issued by Claude Code get a 120-second default timeout (matching Claude Code's default), since OMP's bash has no timeout by default.

## AskClaude tool

Available whenever the active provider is **not** claude-bridge. Your current model can hand work to Claude Code and wait for the result:

- "Ask Claude to plan a fix."
- "If you get stuck, ask Claude for help."
- "Ask Claude to review the plan in @foo.md, implement it, then ask an `isolated=true` Claude to review the implementation."
- "Ask Claude to poke holes in this theory."
- "Find all the places in the codebase that handle auth."

You can also bake it into a skill or AGENTS.md, e.g. *"Always call AskClaude to review complicated feature implementations before considering the task complete."*

### Parameters

| Parameter | Values | Description |
| --------- | ------ | ----------- |
| `prompt` | string | The question or task for Claude Code. |
| `mode` | `read` (default), `none`, `full` | `read` = read files + web; `full` = read/write/bash. Lock `full` out with `allowFullMode: false`. |
| `model` | partial family name (e.g. `opus`, `mythos`) or full id | Which Claude model handles the delegation; partial names resolve to the newest discovered revision. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Effort level. |
| `isolated` | boolean (default `false`) | When `true`, Claude gets a clean session with no conversation history. |

## Configuration reference

Config is read from `~/.omp/agent/claude-bridge.json` (global) and the project OMP config directory `.omp/claude-bridge.json` (project; merged over global). A starter file lives at [`claude-bridge.example.json`](claude-bridge.example.json).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false
  },
  "provider": {
    "strictMcpConfig": true
  }
}
```

**`askClaude`**

| Key | Default | Description |
| --- | ------- | ----------- |
| `enabled` | `true` | Register the AskClaude tool. |
| `name` | `"AskClaude"` | Override the tool's OMP-side name. |
| `label` | `"Ask Claude Code"` | Override the TUI label. |
| `description` | — | Override the tool description shown to the model. |
| `defaultMode` | `"read"` | `read`, `none`, or `full`. |
| `defaultIsolated` | `false` | Start each call in a fresh session. |
| `allowFullMode` | `true` | Allow `mode: "full"`; set `false` to lock it out. |
| `appendSkills` | `true` | Forward OMP's skills block into the system prompt. |

**`provider`**

| Key | Default | Description |
| --- | ------- | ----------- |
| `appendSystemPrompt` | `true` | Project OMP's portable system-prompt additions (context files, skills, custom/append text, and subagent task context) behind Claude Code's preset. Set `false` to hand Claude Code only its own preset plus `settingSources`. |
| `settingSources` | — | Claude Code filesystem settings to load; only applied when `appendSystemPrompt: false`. |
| `strictMcpConfig` | `true` | Block MCP servers from `~/.claude.json` / `.mcp.json`. Cloud MCP is always blocked. |
| `pathToClaudeCodeExecutable` | — | Path to the `claude` binary, if the bundled one is too old for a model or can't run on your OS/filesystem. Prefer a stable launcher/symlink path such as `~/.local/bin/claude`. |

## How it works

OMP's built-in tools are bridged to Claude Code and back, so from your side it behaves like any other OMP provider. Model discovery and context-window resolution live in [`src/models.ts`](src/models.ts), which is deliberately free of runtime imports so they stay unit-testable in isolation. On registration, the extension discovers bridge-compatible Claude models from OMP's Anthropic catalogue and registers each one with the catalogue's canonical `contextWindow` verbatim — there is no exact-id capability table to maintain. The Claude Agent SDK's runtime `supportedModels()` API is intentionally not part of initial registration — OMP needs the model list synchronously at startup, and that API carries no context-window metadata anyway — so the catalogue is the source of truth for capability.

### System-prompt transport

Claude Code always starts with its own native `claude_code` preset — the bridge never
replaces it with OMP's assembled system prompt. Instead it *projects* only the portable
parts of what OMP built onto Claude Code's preset via the preset's `append`:

- **project context files** (AGENTS.md/CLAUDE.md) reach Claude Code once;
- **applicable skills** reach Claude Code once;
- **custom and append system-prompt text** reach Claude Code once;
- a **subagent's role/assignment block** — including native `task.context` (e.g. a
  sequential-decomposition child's `PRIOR_PHASE_RESULTS`) — reaches the child once.
  This is the class of content that used to disappear behind the bridge.

Why not just `append` OMP's whole assembled system prompt? Because that would duplicate
OMP's harness and tool catalog on top of Claude Code's own, recursively re-embed parent
prompts into child prompts, mix OMP-specific runtime instructions with Claude Code's
harness, and produce enormous prompts. Only the portable delta is projected.

OMP 18.2.2 exposes only the fully-assembled `systemPrompt` string array to extensions
(no structured breakdown), so the bridge records each assembled prompt at
`before_agent_start` keyed by the prompt itself ([`src/prompt-capture.ts`](src/prompt-capture.ts)).
Portable data is derived from the **rendered array itself**, not re-discovered from
`process.cwd()`: this preserves the exact context files OMP supplied to a subagent or
worktree, plus the rendered skills catalogue and whatever append text OMP actually put
in the project/environment footer. Which block owns the append depends on the layout:
`SYSTEM.md` / `--system-prompt` folds it into block 0 (and OMP blanks the footer's copy),
while `SYSTEM_TEMPLATE.md` / `--system-prompt-template` leaves block 0 as the rendered
template and keeps the append in the footer. The bridge reads the footer as rendered
instead of assuming a custom block owns its append. For both custom layouts 18.2.2+
exposes no boundary between `customPrompt` and `appendSystemPrompt`, so that combined
user/project block is preserved losslessly while generated project/skills containers are
removed and re-projected once.

The provider then resolves its received prompt against those captures. Subagent prompt
**inheritance is projected rather than recursively copied**: when a prompt embeds a
previously-captured prompt, the raw parent is replaced by the parent's already-portable
projection, deduplicated, with cycle detection. The capture registry is process-global
(shared via `Symbol.for`, like provider-stream ownership) so a child session can record
under one extension instance while the parent-owned provider callback resolves it. The
registry is released only when that provider-owning instance shuts down; a child-session
shutdown cannot clear captures still needed by the parent.

If a received **coding-agent turn** system prompt matches no capture and embeds no
known capture, the bridge **fails closed** with a diagnostic instead of quietly calling
Claude Code with missing instructions — a recoverable failed turn is better than silently
losing the user's, project's, or agent's instructions.

OMP also performs provider-direct utility completions that intentionally never traverse
`before_agent_start` — auto-thinking classification is one example. OMP's normal agent
loop always supplies a `cwd` to provider options, while these utility calls do not;
explicit side requests are additionally marked `initiatorOverride="agent"`. For such
uncaptured side requests the bridge sends the exact received system prompt verbatim,
without the `claude_code` coding-agent preset. This preserves the utility call's intended
classifier/summarizer semantics while keeping missing captures fail-closed for real agent
turns. A side request that deliberately reuses an exact known capture still receives the
normal portable projection.

Isolated flows owned directly by the bridge (compaction/branch-summary) keep their own
explicit prompts. The AskClaude tool continues to forward the skills block as before.

### Native OMP advisor support

OMP's native advisor is its own Agent with a dedicated `advise` tool and a
system prompt assembled directly by AdvisorController, outside the extension
`before_agent_start` event. The bridge recognizes that OMP-owned contract,
transports the advisor's complete prompt verbatim (without the Claude Code
coding-agent preset), and isolates its resumable Claude Code session by OMP's
provider `sessionId`. The primary agent retains strict prompt capture and
AskClaude session sharing.

An unrecognized advisor prompt still fails closed rather than silently losing
instructions. After an OMP upgrade that changes the built-in advisor prompt,
update the recognition contract and tests before enabling this transport.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` for detailed logs:

- **Bridge log** — `~/.omp/agent/claude-bridge.log`: every provider call, session-sync decision, tool-result delivery, and Claude Code stderr. Override the path with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Reasoning-effort mapping** — provider and AskClaude calls emit a dedicated `reasoning-map` line with the registered/CLI model, the reasoning level requested by OMP, and the effort actually passed to the Claude Agent SDK. For example, `requestedReasoning=xhigh mappedEffort=xhigh`. Check it with `grep 'reasoning-map' ~/.omp/agent/claude-bridge.log`.
- **Per-query CLI logs** — `~/.omp/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log`: the Claude Code subprocess's own debug stream, one file per query. Tags are `provider`, `continuation`, or `askclaude`.

When filing a session-resume bug (e.g. "No conversation found"), the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file are the most useful attachments.

## Development

```bash
git clone https://github.com/DevVig/omp-claude-bridge.git
cd omp-claude-bridge
bun install

bun run typecheck   # tsc --noEmit
bun run test        # node --test unit suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. CI runs typecheck and tests on every push and PR.

## Credits

- Original **[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)** by **[Eli Dickinson](https://github.com/elidickinson)** — the streaming provider, MCP/tool bridging, session resume, and AskClaude tool this project builds on.
- Initial inspiration from [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.
- **Oh My Pi port and context-window controls** by **[Jonathan Borgwing](https://github.com/DevVig)**.

See [NOTICE](NOTICE) for full attribution.

> Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how Agent-SDK tool usage is billed. As of June 15, 2026 it uses your subscription quota just like Claude Code direct.

## License

[MIT](LICENSE) © 2026 Eli Dickinson (original) and Jonathan Borgwing (Oh My Pi port and context-window controls).

// Prompt capture + projection for faithful OMP → Claude Code system-prompt transport.
//
// Claude Code keeps its own `claude_code` preset, which already carries the base
// coding-agent harness (tool policy, workstation, general guidance). What it does
// NOT carry is the portable material OMP assembled for THIS agent: project
// context files (AGENTS.md/CLAUDE.md), the skills/rules blocks, custom/append
// prompt text, and — the bug this module fixes — a subagent's `§ Role`/`§ Context`
// block, which is where native `task.context` (e.g. PRIOR_PHASE_RESULTS) lives.
//
// The bridge must project ONLY those portable parts behind the preset. Appending
// OMP's entire assembled system prompt is rejected: it duplicates the harness and
// tool catalog, recursively re-embeds parent prompts into child prompts, and
// mixes OMP-specific runtime instructions with Claude Code's own harness.
//
// OMP 18.2.2's `before_agent_start` exposes only the fully assembled
// `systemPrompt: string[]` (no structured `systemPromptOptions`), so index.ts
// derives the structured `PromptCaptureInput` from that array and records it here,
// keyed by the assembled prompt. The provider then resolves the `context.systemPrompt`
// it receives against the capture and projects the portable parts.
//
// Design (mechanism, not code) ported from elidickinson/pi-claude-bridge's
// `PromptCaptures`, adapted to this fork: text sections instead of `Skill[]`
// objects (OMP does not expose them to extensions), plus a process-global shared
// registry so a child session that records under one extension module instance is
// resolvable from the provider callback owned by the parent instance.

import { formatProjectContext } from "./agents-md.js";

/** One applicable skill, kept as pre-rendered text. `id` dedupes across inheritance
 *  (equivalent to the reference's `filePath`). `disabled` skips model-invocable rendering. */
export interface CapturedSkill {
	id: string;
	content: string;
	disabled?: boolean;
}

/** One rendered OMP rules container from the generated default harness.
 * `id` dedupes byte-identical rule blocks across prompt inheritance. */
export interface CapturedRuleBlock {
	id: string;
	content: string;
}

/** The portable, structured inputs OMP used to assemble one agent's prompt. */
export interface PromptCaptureInput {
	/** Per-agent custom prose. For a subagent this is the `§ Role`/`§ Context`/`§ Plan`
	 *  block carrying its assignment and native `task.context`. */
	custom?: string;
	/** User-authored append text (session config / CLI `--append-system-prompt`). */
	append?: string;
	/** Project context files (AGENTS.md/CLAUDE.md), deduped by `path` on projection. */
	contextFiles: Array<{ path: string; content: string }>;
	/** Skills available to this agent, deduped by `id` on projection. */
	skills: CapturedSkill[];
	/** Rendered <generic-rules>/<domain-rules> blocks from OMP's default harness. */
	rules?: CapturedRuleBlock[];
}

interface InheritedPrompt {
	start: number;
	end: number;
	parent: PromptCapture;
}

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
};

export interface PromptCaptureDiagnostic {
	/** The prompt that matched nothing; too large to log inline, so callers log a
	 *  fingerprint plus the closest known match's first divergent offset. */
	systemPrompt: string;
	matches: Array<{ key: string; firstDivergent: number }>;
}

/**
 * Captures keyed by the fully assembled prompt OMP sends to a provider.
 *
 * A subagent's system prompt may embed a previously assembled parent prompt
 * verbatim. OMP 18.2.2 exposes it as ordinary prompt text without provenance, so
 * linking exact prior keys recovers the inheritance graph without recognizing OMP
 * prose or subagent markers.
 */
export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();
	private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void;

	/** `limit` is set well above any plausible working set: a capture is tens of KB,
	 *  while evicting a still-live one fails a turn. The bound only caps an extension
	 *  that rebuilds the prompt every turn. */
	constructor(private readonly limit = 256, onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void) {
		this.onDiagnose = onDiagnose ?? (() => {});
	}

	record(systemPrompt: string, input: PromptCaptureInput): void {
		if (!systemPrompt) return;
		const existing = this.captures.get(systemPrompt);
		const customChanged = existing?.custom !== input.custom;
		const capture: PromptCapture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			rules: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = input.skills.map((skill) => ({ ...skill }));
		capture.rules = (input.rules ?? []).map((rule) => ({ ...rule }));
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		// Mutate the existing node in place so descendants keep a live reference,
		// then re-insert its key so Map order tracks recency.
		this.touch(systemPrompt, capture);
	}

	/** Exact lookup only. Query servers want {@link resolveOrDerive}. */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	/**
	 * The capture to project for one query.
	 *
	 * Exact key is the normal case. A prompt that only *embeds* known prompts —
	 * anything that wrapped what OMP assembled after we recorded it — resolves to a
	 * transient descendant over the whole prompt: projection swaps each embedded
	 * capture for its portable parts and carries the surrounding wrapper text
	 * through unchanged (dropping it would be the silent instruction loss this
	 * exists to prevent).
	 *
	 * Throws when a prompt matches neither route. Returning an empty capture would
	 * hand Claude Code a turn with none of the user's context files, skills, custom
	 * or append text — silently discarding policy the user wrote down. A failed turn
	 * is recoverable; a silently under-instructed one is not.
	 */
	resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const exact = this.captures.get(systemPrompt);
		if (exact) {
			this.touch(systemPrompt, exact);
			return exact;
		}

		// A capture can outlive its lookup key: eviction drops the key while
		// inheritance edges keep the node alive. Revive an exact-content match.
		const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);
		if (revived) {
			this.touch(systemPrompt, revived);
			return revived;
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			const matches = this.closestKnown(systemPrompt);
			this.onDiagnose({ systemPrompt, matches });
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Closest known match diverges at offset ${matches[0]?.firstDivergent ?? "?"} (${matches.length ? matches[0].key.length : 0}-char key). `
				+ `Claude Code would receive none of this turn's context files, skills, rules or custom instructions. `
				+ `The usual cause is an extension loaded after claude-bridge that rewrites the system prompt from before_agent_start, or OMP rebuilding the prompt outside before_agent_start.`,
			);
		}

		// `custom` is the prompt itself and edges keep their original offsets, so
		// projection substitutes the embedded captures in place and preserves every
		// byte between and around them.
		return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], inherited: embedded };
	}

	get size(): number {
		return this.captures.size;
	}

	/** Drop all lookup keys and inherited nodes owned only by this registry. */
	clear(): void {
		this.captures.clear();
	}

	/** Recency is by use, not just by record: a parent records once then only
	 *  resolves, so counting writes alone ages it out behind churning subagent
	 *  prompts. */
	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/** Longest shared-prefix matches, best first, for the throw diagnostic. */
	private closestKnown(systemPrompt: string): Array<{ key: string; firstDivergent: number }> {
		let shared = 0;
		const matches: Array<{ key: string; firstDivergent: number }> = [];
		for (const key of this.captures.keys()) {
			const limit = Math.min(key.length, systemPrompt.length);
			let i = 0;
			while (i < limit && key.charCodeAt(i) === systemPrompt.charCodeAt(i)) i++;
			if (i >= shared) {
				if (i > shared) {
					shared = i;
					matches.length = 0;
				}
				matches.push({ key, firstDivergent: i });
			}
		}
		return matches;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		// A grandchild embeds both its parent's key and the grandparent nested
		// inside it. Keep the longest exact non-overlapping matches.
		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

/** Project a capture to the portable append that follows Claude Code's preset. */
export function projectPromptCapture(capture: PromptCapture): string | undefined {
	return projectCapture(capture, new Set());
}

/** Skills reachable through inherited prompts, ancestor first, once per id. */
export function collectPromptSkills(capture: PromptCapture): CapturedSkill[] {
	const result: CapturedSkill[] = [];
	const seenIds = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const skill of node.skills) {
			if (skill.disabled || seenIds.has(skill.id)) continue;
			seenIds.add(skill.id);
			result.push(skill);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

/** Rule blocks reachable through inherited prompts, ancestor first, once per id. */
export function collectPromptRules(capture: PromptCapture): CapturedRuleBlock[] {
	const result: CapturedRuleBlock[] = [];
	const seenIds = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const rule of node.rules ?? []) {
			if (seenIds.has(rule.id)) continue;
			seenIds.add(rule.id);
			result.push(rule);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

/** Context-file paths reachable through inherited prompts, once each. */
export function collectPromptContextPaths(capture: PromptCapture): Set<string> {
	const paths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const file of node.contextFiles) paths.add(file.path);
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return paths;
}

function renderSkills(skills: CapturedSkill[]): string | undefined {
	const parts = skills.map((skill) => skill.content.trim()).filter((content) => content.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function renderRules(rules: CapturedRuleBlock[]): string | undefined {
	const parts = rules.map((rule) => rule.content.trim()).filter((content) => content.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function projectCapture(capture: PromptCapture, visiting: Set<PromptCapture>): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		// Skills/rules/context an ancestor already contributes are rendered via the
		// substituted parent projection inside `custom`; drop them from this node so
		// inherited material appears exactly once.
		const inheritedSkillIds = new Set(
			capture.inherited.flatMap((edge) => collectPromptSkills(edge.parent).map((skill) => skill.id)),
		);
		const ownSkillIds = new Set<string>();
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disabled || inheritedSkillIds.has(skill.id) || ownSkillIds.has(skill.id)) return false;
			ownSkillIds.add(skill.id);
			return true;
		});

		const inheritedRuleIds = new Set(
			capture.inherited.flatMap((edge) => collectPromptRules(edge.parent).map((rule) => rule.id)),
		);
		const ownRuleIds = new Set<string>();
		const ownRules = (capture.rules ?? []).filter((rule) => {
			if (inheritedRuleIds.has(rule.id) || ownRuleIds.has(rule.id)) return false;
			ownRuleIds.add(rule.id);
			return true;
		});

		const inheritedContextPaths = new Set(
			capture.inherited.flatMap((edge) => [...collectPromptContextPaths(edge.parent)]),
		);
		const ownContextPaths = new Set<string>();
		const ownContextFiles = capture.contextFiles.filter((file) => {
			if (inheritedContextPaths.has(file.path) || ownContextPaths.has(file.path)) return false;
			ownContextPaths.add(file.path);
			return true;
		});

		const custom = projectCustom(capture, visiting);
		const parts = [
			formatProjectContext(ownContextFiles),
			renderSkills(ownSkills),
			renderRules(ownRules),
			custom,
			capture.append,
		].filter((part): part is string => Boolean(part && part.trim()));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function projectCustom(capture: PromptCapture, visiting: Set<PromptCapture>): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}

// --- Process-global shared registry ---------------------------------------
// OMP re-binds one extension module evaluation across sessions: a subagent
// session gets a fresh ExtensionAPI but the already-imported factory
// (`preloadedPreparedExtensions`), and a re-loaded child may instead evaluate
// the module again while the shared ModelRegistry's streamSimple still belongs
// to the parent instance (see provider-registration.ts). Either way a prompt
// recorded at one session's before_agent_start must be resolvable from the
// provider callback serving another. A module-local `new PromptCaptures()`
// would not span both, so the registry lives in a Symbol.for() global keyed
// like the shared provider stream.
//
// The registry is released only once the last session bound to the shared
// provider registration has shut down. A child/subagent session leaving while
// its parent still runs MUST NOT clear it: the parent-owned provider callback
// resolves the parent's in-flight turn and any still-draining child captures
// from it.

export const PROMPT_CAPTURES_KEY = Symbol.for("claude-bridge:promptCaptures");

export function sharedPromptCaptures(
	globalState: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
	options?: { limit?: number; onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void },
): PromptCaptures {
	const existing = globalState[PROMPT_CAPTURES_KEY] as PromptCaptures | undefined;
	if (existing) return existing;
	const created = new PromptCaptures(options?.limit ?? 256, options?.onDiagnose);
	globalState[PROMPT_CAPTURES_KEY] = created;
	return created;
}

/** Release the process-global capture registry when its provider owner exits. */
export function releaseSharedPromptCaptures(
	captures: PromptCaptures,
	globalState: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): boolean {
	if (globalState[PROMPT_CAPTURES_KEY] !== captures) return false;
	captures.clear();
	delete globalState[PROMPT_CAPTURES_KEY];
	return true;
}

// --- Assembled-array derivation --------------------------------------------
//
// `before_agent_start` exposes only the final `systemPrompt: string[]` — still
// true at OMP v18.2.8 (`extensibility/extensions/types.ts BeforeAgentStartEvent`).
// It does NOT expose the structured customPrompt, appendSystemPrompt,
// contextFiles, or skills that built it.
//
// Re-reading those inputs from disk is incorrect: a subagent can run in a
// different cwd/worktree and createAgentSession can supply preloaded context
// files that differ from a fresh discovery pass. Derivation therefore reads the
// exact rendered array OMP is about to send.
//
// Three OMP layouts matter (v18.2.8 `system-prompt.ts` selects block 0 and the
// PROJECT footer's data from one flag, `resolvedCustomPrompt`):
// - default prompt: generated harness in block 0, project/context + append in a
//   PROJECT block, and a subagent role/context block when applicable;
// - literal custom prompt (SYSTEM.md / --system-prompt): block 0 is itself
//   user/project-specific content (custom + append + rendered
//   context/skills/rules), not the default OMP harness, and OMP deliberately
//   blanks the footer's contextFiles/appendPrompt so neither is emitted twice;
// - custom template (SYSTEM_TEMPLATE.md / --system-prompt-template): block 0 is
//   the user's rendered Handlebars template, but `resolvedCustomPrompt` stays
//   undefined, so the PROJECT footer keeps rendering the real contextFiles and
//   appendPrompt.
//
// Block 0 being portable therefore does NOT imply it owns the append; only the
// literal-custom route folds the append into it. Derivation reads the append
// from the rendered PROJECT footer instead of inferring it from block 0.
//
// For both custom layouts we keep the non-generated remainder of block 0 as a
// single portable custom block because OMP exposes no provenance that would let
// us split customPrompt from appendSystemPrompt losslessly.

/** Verbatim line unique to `subagent-system-prompt.md`; marks the array entry
 * that holds a subagent's role, assignment context, and plan. */
export const SUBAGENT_BLOCK_MARKER = "You are operating on a piece of work assigned to you by the main agent.";

// OMP's bundled default harness (`packages/coding-agent/src/prompts/system/system-prompt.md`)
// is generated, non-portable content: Claude Code's `claude_code` preset already
// carries an equivalent base harness, so block 0 of a default-layout prompt must
// be recognized and dropped rather than forwarded as portable custom text.
//
// Match the known opening and ordered section spine for each rendered layout.
// The recent 18.x template uses ⁂ headings, and 19.0 puts the role in the
// opening line. Earlier 18.x templates use § headings and a role section.
interface DefaultHarnessGeneration {
	opening: string;
	sectionMarker: "§" | "⁂";
	roleHeading?: string;
}

const RFC_HARNESS_OPENING = "RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.";
const MODERN_HARNESS_ROLE = "You are omp's trusted coding assistant.";
const DEFAULT_HARNESS_GENERATIONS: readonly DefaultHarnessGeneration[] = [
	{
		opening: `${MODERN_HARNESS_ROLE}\n`,
		sectionMarker: "⁂",
	},
	{
		opening: "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
		sectionMarker: "⁂",
		roleHeading: `\n⁂ Role\n${MODERN_HARNESS_ROLE}\n`,
	},
	{
		opening: RFC_HARNESS_OPENING,
		sectionMarker: "§",
		roleHeading: "\n§ Role\nYou are a helpful, trusted assistant working in Oh My Pi coding harness.\n",
	},
	{
		opening: `<conventions>\n${RFC_HARNESS_OPENING}`,
		sectionMarker: "§",
		roleHeading: "\n§ Role\nHelpful, trusted assistant for load-bearing changes in Oh My Pi coding harness.\n",
	},
];

// Scratchpad is conditional on the tool set. These sections always render.
const DEFAULT_HARNESS_SECTIONS = ["Runtime", "Tool Policy", "Workflow", "Delivery", "Critical"];

const MODERN_SKILLS_MARKER = "Matching skill → MUST read skill://<name> first.";
const DEFAULT_SKILLS_MARKER = "Matching skill → MUST read `skill://<name>` first.";
const CUSTOM_SKILLS_MARKER = "Skills are specialized knowledge. Scan descriptions for your task domain.";
const LEGACY_SKILLS_MARKER = "The following skills provide specialized instructions for specific tasks.";
const GENERIC_RULES_OPEN = "<generic-rules>";
const GENERIC_RULES_CLOSE = "</generic-rules>";
const DOMAIN_RULES_OPEN = "<domain-rules>";
const DOMAIN_RULES_CLOSE = "</domain-rules>";
const PROJECT_CRITICAL_MARKER = "<critical>\n- Each response MUST advance the task; completion only stopping condition.";

function compactJoin(parts: Array<string | undefined>): string | undefined {
	const present = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
	return present.length > 0 ? present.join("\n\n") : undefined;
}

/** True only for OMP's generated default system harness.
 *
 * Deliberately over-specified. A false positive silently drops a user's real
 * custom prompt; a false negative only duplicates a harness, which is loud. A
 * block therefore qualifies only when it opens with a known generation's exact
 * first bytes, carries its exact role heading if the role is not in the opening,
 * and holds every unconditional section in template order.
 *
 * The remaining reachable false positive is a SYSTEM.md / template override that
 * copies the bundled harness and edits it, so a block rendered from
 * `custom-system-prompt.md` is rejected outright: that template alone emits the
 * generated `<project>` container and its own skills preamble, and neither string
 * exists in `system-prompt.md`. The guard is partial — both containers are
 * conditional on the agent actually having context files or skills — but it costs
 * nothing and covers the common case. */
function isDefaultHarnessBlock(block: string | undefined): boolean {
	const text = block?.trimStart();
	if (!text) return false;
	if (text.includes(CUSTOM_SKILLS_MARKER) || findGeneratedCustomProject(text)) return false;

	const generation = DEFAULT_HARNESS_GENERATIONS.find(({ opening, roleHeading }) =>
		text.startsWith(opening) && (!roleHeading || text.includes(roleHeading)),
	);
	if (!generation) return false;

	let cursor = generation.roleHeading ? text.indexOf(generation.roleHeading) : 0;
	for (const section of DEFAULT_HARNESS_SECTIONS) {
		const heading = `\n${generation.sectionMarker} ${section}\n`;
		const at = text.indexOf(heading, cursor);
		if (at === -1) return false;
		cursor = at + heading.length;
	}
	return true;
}

function removeRange(source: string, start: number, end: number): string {
	return `${source.slice(0, start)}\n${source.slice(end)}`;
}

function extractTaggedContainer(source: string, open: string, close: string): string | undefined {
	const start = source.indexOf(open);
	if (start === -1) return undefined;
	const end = source.indexOf(close, start + open.length);
	if (end === -1) return undefined;
	return source.slice(start, end + close.length);
}

function findGeneratedCustomProject(source: string): { text: string; start: number; end: number } | undefined {
	// custom-system-prompt.md emits <project> only for Context and/or Version
	// Control, and the first generated heading is therefore one of these two.
	const re = /<project>\s*\n(?=## (?:Context|Version Control)\b)[\s\S]*?<\/project>/;
	const match = re.exec(source);
	if (!match || match.index === undefined) return undefined;
	return { text: match[0], start: match.index, end: match.index + match[0].length };
}

function parseContextFiles(container: string | undefined): Array<{ path: string; content: string }> {
	if (!container) return [];
	const result: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();
	const re = /<file path="([^"]+)">\s*\n?([\s\S]*?)\n?\s*<\/file>/g;
	for (const match of container.matchAll(re)) {
		const path = match[1]?.trim();
		const content = match[2]?.trim();
		if (!path || !content || seen.has(path)) continue;
		seen.add(path);
		result.push({ path, content });
	}
	return result;
}

/** Context files exactly as OMP rendered them for this agent. */
export function extractRenderedContextFiles(assembled: string[]): Array<{ path: string; content: string }> {
	const result: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();

	for (const block of assembled) {
		const customProject = findGeneratedCustomProject(block)?.text;
		const containers = [
			extractTaggedContainer(block, "<repo-rules>", "</repo-rules>"),
			// custom-system-prompt.md nests context files inside the generated
			// <project>/<instructions> container. Scope to that generated project so
			// user-authored <instructions> markup is never mistaken for context files.
			customProject ? extractTaggedContainer(customProject, "<instructions>", "</instructions>") : undefined,
		];
		for (const container of containers) {
			for (const file of parseContextFiles(container)) {
				if (seen.has(file.path)) continue;
				seen.add(file.path);
				result.push(file);
			}
		}
	}
	return result;
}

function extractSkillsFromBlock(block: string): string | undefined {
	for (const marker of [MODERN_SKILLS_MARKER, DEFAULT_SKILLS_MARKER, CUSTOM_SKILLS_MARKER, LEGACY_SKILLS_MARKER]) {
		const start = block.lastIndexOf(marker);
		if (start === -1) continue;
		const closeTag = marker === LEGACY_SKILLS_MARKER ? "</available_skills>" : "</skills>";
		const end = block.indexOf(closeTag, start);
		if (end === -1) continue;
		return block.slice(start, end + closeTag.length).trim();
	}
	return undefined;
}

/** Skills catalogue/instructions exactly as rendered by supported OMP layouts. */
export function extractRenderedSkillsBlock(assembled: string[]): string | undefined {
	for (const block of assembled) {
		const skills = extractSkillsFromBlock(block);
		if (skills) return skills;
	}
	return undefined;
}

/** OMP rule containers rendered inside the generated default harness.
 *
 * Custom-system-prompt rules are intentionally not extracted here: that layout
 * already preserves its rule prose inside `custom`. */
export function extractRenderedRuleBlocks(assembled: string[]): CapturedRuleBlock[] {
	const result: CapturedRuleBlock[] = [];
	const seenIds = new Set<string>();

	for (const block of assembled) {
		const runtimeStart = block.search(/\n[§⁂] Runtime\n/);
		if (runtimeStart === -1) continue;
		const rulesHeading = block.indexOf("# Skills & Rules", runtimeStart);
		if (rulesHeading === -1) continue;
		const internalUrls = block.indexOf("\n# Internal URLs", rulesHeading);
		const sectionEnd = internalUrls === -1 ? block.length : internalUrls;

		// Skill descriptions are user-controlled and rendered before rule containers.
		// Skip the skills region only when its real generated opener exists; a stray
		// </skills> inside arbitrary rule prose must never move the parser cursor.
		let cursor = rulesHeading + "# Skills & Rules".length;
		const skillsOpen = block.indexOf("<skills>", cursor);
		if (skillsOpen !== -1 && skillsOpen < sectionEnd) {
			const skillsClose = block.indexOf("</skills>", skillsOpen + "<skills>".length);
			if (skillsClose !== -1 && skillsClose < sectionEnd) cursor = skillsClose + "</skills>".length;
		}

		const push = (kind: "generic" | "domain", openAt: number, open: string, close: string): void => {
			const closeAt = block.indexOf(close, openAt + open.length);
			if (closeAt === -1 || closeAt >= sectionEnd) return;
			const content = block.slice(openAt, closeAt + close.length).trim();
			cursor = closeAt + close.length;
			const id = `${kind}:${content}`;
			if (seenIds.has(id)) return;
			seenIds.add(id);
			const portable =
				kind === "domain"
					? `Rules are local constraints. You MUST read \`rule://<name>\` when working in that domain.\n${content}`
					: content;
			result.push({ id, content: portable });
		};

		// Generated order is generic first, domain second. Only accept a generic
		// opener that appears before the generated domain opener; this prevents
		// XML-like text inside a domain-rule description from impersonating the
		// missing generic container.
		const genericOpenAt = block.indexOf(GENERIC_RULES_OPEN, cursor);
		const firstDomainOpenAt = block.indexOf(DOMAIN_RULES_OPEN, cursor);
		if (
			genericOpenAt !== -1
			&& genericOpenAt < sectionEnd
			&& (firstDomainOpenAt === -1 || genericOpenAt < firstDomainOpenAt)
		) {
			push("generic", genericOpenAt, GENERIC_RULES_OPEN, GENERIC_RULES_CLOSE);
		}

		const domainOpenAt = block.indexOf(DOMAIN_RULES_OPEN, cursor);
		if (domainOpenAt !== -1 && domainOpenAt < sectionEnd) {
			push("domain", domainOpenAt, DOMAIN_RULES_OPEN, DOMAIN_RULES_CLOSE);
		}
	}
	return result;
}

/** The subagent role/context/plan block from an assembled prompt array, or
 * undefined for a main-agent prompt that has no such block. */
export function extractSubagentBlock(assembled: string[]): string | undefined {
	const block = assembled.find((part) => part.includes(SUBAGENT_BLOCK_MARKER));
	return block ? block.trim() : undefined;
}

/** Read the append after the generated critical block in either footer layout.
 * Skip block zero, which can contain user-authored text that quotes the footer.
 * The modern layout puts the critical block after the project-context wrapper.
 */
export function extractProjectAppendBlock(assembled: string[]): string | undefined {
	for (const block of assembled.slice(1)) {
		const project = block.trimStart();
		const marker = project.startsWith("<project-context>\n")
			? `\n</project-context>\n\n${PROJECT_CRITICAL_MARKER}`
			: PROJECT_CRITICAL_MARKER;
		if (marker === PROJECT_CRITICAL_MARKER && !project.startsWith("PROJECT\n")) continue;
		const generatedStart = project.indexOf(marker);
		if (generatedStart === -1) continue;
		const close = "</critical>";
		const boundary = project.indexOf(close, generatedStart + marker.length);
		if (boundary !== -1) return project.slice(boundary + close.length).trim() || undefined;
	}
	return undefined;
}

/**
 * Portable content from OMP's custom-system-prompt.md.
 *
 * The custom template replaces the normal OMP harness. Preserve its user/project
 * instructions, but remove the generated <project> container and rendered skills
 * catalogue because those are captured structurally and re-rendered once.
 *
 * OMP 18.2.2 concatenates SYSTEM.md/customPrompt/appendPrompt without provenance,
 * so they intentionally remain one portable block.
 */
export function extractCustomPromptBlock(assembled: string[]): string | undefined {
	const first = assembled[0]?.trim();
	if (!first || isDefaultHarnessBlock(first) || first.includes(SUBAGENT_BLOCK_MARKER)) return undefined;

	let portable = first;
	const generatedProject = findGeneratedCustomProject(portable);
	if (generatedProject) {
		portable = removeRange(portable, generatedProject.start, generatedProject.end);
	}

	const skills = extractSkillsFromBlock(portable);
	if (skills) {
		const skillStart = portable.indexOf(skills);
		if (skillStart !== -1) {
			portable = removeRange(portable, skillStart, skillStart + skills.length);
		}
	}

	const trimmed = portable.trim();
	return trimmed || undefined;
}

/** Build the structured capture directly from the exact OMP-rendered array. */
export function deriveCaptureInput(assembled: string[]): PromptCaptureInput {
	const customPrompt = extractCustomPromptBlock(assembled);
	const subagent = extractSubagentBlock(assembled);
	const contextFiles = extractRenderedContextFiles(assembled);
	const skillsBlock = extractRenderedSkillsBlock(assembled);
	// Only the generated default harness owns these tagged containers. A genuine
	// custom prompt may quote the same XML-like strings and must stay byte-faithful.
	const rules = isDefaultHarnessBlock(assembled[0]) ? extractRenderedRuleBlocks([assembled[0]!]) : [];

	return {
		custom: compactJoin([customPrompt, subagent]),
		// Older literal overrides put the append in block zero. Current OMP
		// renders it in the footer even with a literal override. Read the actual
		// footer tail so both placements work without inferring the host version.
		append: extractProjectAppendBlock(assembled),
		contextFiles,
		skills: skillsBlock ? [{ id: "omp-skills", content: skillsBlock }] : [],
		rules,
	};
}

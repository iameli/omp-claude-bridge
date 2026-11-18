import { PromptCaptures, projectPromptCapture } from "./prompt-capture.js";

export interface PromptTransportOptions {
	cwd?: string;
	initiatorOverride?: string;
	/** OMP advisor Agent bypasses before_agent_start but has an authoritative prompt. */
	nativeAdvisor?: boolean;
}

export type ProviderPromptTransport =
	| {
			mode: "agent-preset";
			append?: string;
	  }
	| {
			mode: "verbatim-side-request";
			systemPrompt?: string;
	  };

/**
 * Resolve how one provider call should transport its system prompt to Claude Code.
 *
 * Normal OMP coding-agent turns always carry a cwd through agent-loop. A *fresh*
 * turn traverses before_agent_start immediately before its first provider call,
 * so its prompt is captured. Later calls in the same turn — the tool loop, and
 * OMP 18.2.8 automatic continuations such as the todo reminder's
 * `scheduleAgentContinue` → `agent.continue()` — reuse that same established
 * prompt without emitting before_agent_start again. They therefore still MUST
 * resolve through PromptCaptures, and a miss remains fail-closed: an
 * unaccountable prompt on a cwd-bearing call means the portable OMP material
 * would be silently dropped.
 *
 * Keeping the capture reachable for the whole life of a turn is the registry's
 * job, not this function's — see provider-registration.ts, where shared state
 * is released only once the last bound session shuts down.
 *
 * OMP also invokes providers directly through completeSimple() for utility/side
 * requests such as auto-thinking. Those calls do not traverse
 * before_agent_start, so no capture can exist by design. They normally have no
 * cwd; explicit agent-attributed side requests use initiatorOverride="agent".
 * For those calls the exact provider Context system prompt is already the
 * authoritative prompt, so send it verbatim instead of layering it onto the
 * claude_code coding-agent preset.
 */
export function resolveProviderPromptTransport(
	captures: PromptCaptures,
	systemPrompt: string | undefined,
	options?: PromptTransportOptions,
): ProviderPromptTransport {
	// Native OMP advisors are full Agents with cwd, but their prompt is built
	// directly by AdvisorController and never enters before_agent_start. The
	// caller must verify both the dedicated advise tool and built-in prompt.
	if (options?.nativeAdvisor) {
		return { mode: "verbatim-side-request", systemPrompt: systemPrompt || undefined };
	}
	const isSideRequest = options?.cwd === undefined || options?.initiatorOverride === "agent";

	if (isSideRequest) {
		/*
		 * Prefer a known capture when one exists: a side request can deliberately
		 * reuse a previously assembled agent prompt, in which case projection
		 * still avoids duplicating the OMP harness. An uncaptured side request is
		 * expected and carries its exact prompt verbatim.
		 */
		const known = captures.resolve(systemPrompt);
		if (known) {
			return {
				mode: "agent-preset",
				append: projectPromptCapture(known) || undefined,
			};
		}

		return {
			mode: "verbatim-side-request",
			systemPrompt: systemPrompt || undefined,
		};
	}

	const capture = captures.resolveOrDerive(systemPrompt);
	return {
		mode: "agent-preset",
		append: capture ? projectPromptCapture(capture) || undefined : undefined,
	};
}

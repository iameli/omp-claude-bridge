/** Isolate advisor conversations and one-shot requests from the main Claude Code session. */
export interface ProviderSessionSlot<T> {
	current: T | null;
}

export class ProviderSessionScopes<T> {
	/** Main coding agent, also shared with the AskClaude delegation tool. */
	readonly primary: ProviderSessionSlot<T> = { current: null };
	readonly #advisors = new Map<string, ProviderSessionSlot<T>>();

	forRequest(nativeAdvisor: boolean, sessionId?: string, initiatorOverride?: string): ProviderSessionSlot<T> {
		if (!nativeAdvisor) {
			// OMP gives side requests such as background handoff a distinct, one-shot ID.
			if (initiatorOverride === "agent" && sessionId?.includes(":side:")) return { current: null };
			return this.primary;
		}
		if (!sessionId?.trim()) {
			throw new Error("Claude bridge: OMP native advisor must provide a distinct provider sessionId");
		}
		let slot = this.#advisors.get(sessionId);
		if (!slot) {
			slot = { current: null };
			this.#advisors.set(sessionId, slot);
		}
		return slot;
	}

	reset(): void {
		this.primary.current = null;
		this.#advisors.clear();
	}
}

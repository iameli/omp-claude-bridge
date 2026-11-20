/**
 * Recognize the OMP native shadow advisor without trusting cwd as an agent-type
 * indicator. OMP's AdvisorController creates an Agent directly (bypassing
 * before_agent_start), gives it the dedicated 'advise' tool, and installs this
 * built-in prompt. Both signals are required to authorize verbatim transport.
 *
 * If OMP changes its advisor prompt, fail closed until this contract is updated.
 */
const NATIVE_ADVISOR_PROMPT_PREFIX =
	"User, code-quality, robustness advocate; peer-shadow main agent.";
const ADVISOR_CONVENTIONS_PREFIX =
	/^<conventions>\nRFC 2119(?: keywords)?: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL\. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`\.\n<\/conventions>\n\n/;

export function isNativeAdvisorContext(context: {
	readonly systemPrompt?: string | readonly string[];
	readonly tools?: readonly { readonly name: string }[];
}): boolean {
	if (!context.tools?.some(tool => tool.name === "advise")) return false;
	const prompt = Array.isArray(context.systemPrompt)
		? context.systemPrompt.join("\n\n")
		: context.systemPrompt;
	if (typeof prompt !== "string") return false;
	const start = prompt.trimStart().replace(ADVISOR_CONVENTIONS_PREFIX, "");
	return start.startsWith(NATIVE_ADVISOR_PROMPT_PREFIX);
}

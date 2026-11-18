/**
 * Context Usage tool
 *
 * Lets the agent see how full its context window is. Reporting only: what to do
 * with the number is the agent's (or the user's) call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "context_usage",
		label: "Context Usage",
		description:
			"Report how much of the current context window is used: tokens, window size, percent, and tokens left. " +
			"Call this when you need to know how much room is left, e.g. before starting long work.",
		promptSnippet: "Check how much of the context window is used",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const usage = ctx.getContextUsage();
			if (!usage) {
				return {
					content: [{ type: "text", text: "Context usage is unknown: no active model." }],
					details: { tokens: null, contextWindow: null, percent: null },
				};
			}

			const { tokens, contextWindow, percent } = usage;
			if (tokens === null || percent === null) {
				return {
					content: [
						{
							type: "text",
							text: `Context usage is unknown right now (just after compaction, before the next model response). Context window: ${contextWindow.toLocaleString()} tokens.`,
						},
					],
					details: { tokens: null, contextWindow, percent: null },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Context usage: ${percent.toFixed(1)}% (${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens, ${(contextWindow - tokens).toLocaleString()} left).`,
					},
				],
				details: { tokens, contextWindow, percent },
			};
		},
	});
}

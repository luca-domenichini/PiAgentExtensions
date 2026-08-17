/**
 * Model Cost Display Extension
 *
 * Enhances the `/model` command by showing:
 * - Model id and display name
 * - Cost per 1M tokens (input / output / cacheRead) — from Pi's built-in model data
 *
 * Usage: add `/cost` for on-demand cost details.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtCost(val: number | null | undefined): string {
	if (val === null || val === undefined) return "n.a.";
	if (val === 0) return "free";
	if (val < 0.01) return `$${val.toFixed(5)}`;
	if (val < 1) return `$${val.toFixed(4)}`;
	if (val < 10) return `$${val.toFixed(3)}`;
	return `$${val.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Update the status bar with model info
// ---------------------------------------------------------------------------
function updateStatusBar(
	ctx: ExtensionContext,
	modelId: string,
	cost: { input: number; output: number },
) {
	ctx.ui.setStatus(
		"model-cost",
		`🤖 ${modelId} [↑${fmtCost(cost.input)} ↓${fmtCost(cost.output)}/1M]`,
	);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
	// Display model cost on session start (first load, reload, new session, resume, fork)
	pi.on("session_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) {
			ctx.ui.setStatus("model-cost", "🤖 No model selected");
			return;
		}

		updateStatusBar(ctx, model.id, model.cost);
	});

	pi.on("model_select", async (event, ctx) => {
		const { model, source } = event;

		// Skip notifications on session restore to avoid noise
		if (source === "restore") {
			updateStatusBar(ctx, model.id, model.cost);
			return;
		}

		// Build display label
		const label =
			model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;

		// Cost info from Pi's built-in model data
		const cost = model.cost;

		// Notification 1: model name
		ctx.ui.notify(`🧠 Model: ${label}`, "info");

		// Notification 2: cost
		setTimeout(() => {
			const costLine = `🤖 ${model.id} 💰 [↑${fmtCost(cost.cacheRead)} ↑${fmtCost(cost.input)} ↓${fmtCost(cost.output)} /1M]`;
			ctx.ui.notify(costLine, "info");
		}, 300);

		// Status bar
		updateStatusBar(ctx, model.id, cost);

		// Console log
		console.log(
			`[model-cost] ${event.previousModel?.id ?? "none"} → ${model.id} (${source})` +
				` | cost: in=${cost.input} out=${cost.output} cache=${cost.cacheRead}`,
		);
	});

	// Register a /cost command for on-demand details
	pi.registerCommand("cost", {
		description: "Show current model cost",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "warning");
				return;
			}

			const label =
				model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
			const cost = model.cost;

			let msg = `🧠 ${label} (${model.provider})\n`;
			msg += `💰 Cost/1M tokens:\n`;
			msg += `  Input:      ${fmtCost(cost.input)}\n`;
			msg += `  Output:     ${fmtCost(cost.output)}\n`;
			msg += `  CacheRead:  ${fmtCost(cost.cacheRead)}\n`;
			msg += `  CacheWrite: ${fmtCost(cost.cacheWrite)}\n`;
			if (cost.tiers && cost.tiers.length > 0) {
				for (const tier of cost.tiers) {
					msg += `  Tier (>${tier.inputTokensAbove.toLocaleString()} tok): in=${fmtCost(tier.input)} out=${fmtCost(tier.output)}\n`;
				}
			}

			ctx.ui.notify(msg, "info");
		},
	});

}
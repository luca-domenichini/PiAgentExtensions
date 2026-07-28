/**
 * Model Cost & Intelligence Display Extension
 *
 * Enhances the `/model` command by showing:
 * - Model id and display name
 * - Cost per 1M tokens (input / output / cacheRead) — from Pi's built-in model data
 * - Artificial Analysis "Intelligence Index" — from models.json `intelligence` field
 *   (fallback to built-in lookup table)
 *
 * Usage: add `"intelligence": <score>` to any model entry in
 *   ~/.pi/agent/models.json to set its AA Intelligence Index score.
 *   The score appears on `/model` change and in `/cost`.
 *
 * Example models.json entry:
 *   {
 *     "id": "gpt-5.6-luna",
 *     "reasoning": true,
 *     "intelligence": 51.2
 *   }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");

// ---------------------------------------------------------------------------
// Built-in AA Intelligence Index scores (v4.1)
// Used as fallback when models.json doesn't have an `intelligence` field
// for the current model.
// ---------------------------------------------------------------------------
const BUILT_IN_SCORES: Record<string, number> = {
	// OpenAI
	"gpt-5.6-sol": 58.9,
	"gpt-5.6-terra": 55,
	"gpt-5.6-luna": 51.2,
	"gpt-5.4": 42.2,
	"gpt-5.2": 42.2,
	"gpt-5.1": 36.9,
	"gpt-5": 34.7,
	"gpt-4.1": 19.4,
	"gpt-4.1-nano": 8.5,
	"gpt-4.1-mini": 12.3,
	"gpt-4o": 15.5,
	"o4-mini": 22.1,
	"o3": 28.5,
	"o3-mini": 18.2,

	// Anthropic
	"claude-opus-4-7": 53.5,
	"claude-opus-4-6": 43.7,
	"claude-opus-4-5": 34.7,
	"claude-sonnet-4-7": 38.5,
	"claude-sonnet-4": 35.2,
	"claude-4-opus": 25.5,
	"claude-haiku-4": 15.0,
	"claude-3.5-sonnet": 18.5,
	"claude-3-opus": 16.0,
	"claude-3-haiku": 8.5,

	// Google
	"gemini-3.5-flash": 45.4,
	"gemini-2.5-flash": 18.0,
	"gemini-2.5-pro": 25.8,
	"gemini-2.0-flash": 10.5,
	"gemma-4-31b-it": 12.5,
	"gemma-4-9b-it": 7.0,
	"gemma-4-e4b": 8.9,

	// DeepSeek
	"deepseek-v4-pro": 30.0,
	"deepseek-v4": 28.0,
	"deepseek-v3-2": 22.2,
	"deepseek-v3": 14.2,
	"deepseek-r1": 16.5,

	// Mistral
	"mistral-large-4": 28.0,
	"mistral-large-3": 15.9,
	"mistral-small-4": 19.6,
	"mistral-small-3": 10.6,

	// Meta (Llama)
	"llama-4-maverick": 18.5,
	"llama-4-scout": 12.0,
	"llama-3.1-405b": 8.5,
	"llama-3.1-70b": 6.8,
	"llama-3.1-8b": 4.5,

	// Kimi
	"kimi-k2.5": 25.0,
	"kimi-k2": 19.4,

	// Qwen / Alibaba
	"qwen3-235b-a22b": 10.9,
	"qwen3-30b-a3b": 9.3,
	"qwen3-14b": 10.4,
	"qwen3.5-35b-a3b": 29.3,
	"qwen3.5-27b": 29.3,
	"qwen-max": 12.0,
	"qwen-plus": 8.5,
	"qwen-turbo": 6.0,

	// Others
	"minimax-m2-7": 38.1,
	"grok-4-1": 16.9,
	"grok-4-20": 22.5,
	"nova-pro": 7.7,
	"command-a": 7.7,
	"glm-5": 39.5,
	"exaone-4-5-33b": 23.0,
	"doubao-seed-code": 26.0,
	"nex-n2-pro": 41.0,
	"sarvam-105b": 11.9,
};

// ---------------------------------------------------------------------------
// In-memory cache for intelligence scores read from models.json
// Keyed by model id. Reloaded on each `/model` open cycle.
// ---------------------------------------------------------------------------
let fileScoresCache: Record<string, number> | null = null;
let fileScoresMtime = 0;

/**
 * Read intelligence scores from ~/.pi/agent/models.json.
 * Returns a map of model id → intelligence score.
 * Cached based on file mtime so it's efficient across model switches.
 */
function loadFileScores(): Record<string, number> {
	try {
		let mtime = 0;
		try {
			mtime = statSync(MODELS_JSON_PATH).mtimeMs;
		} catch {
			// File doesn't exist or can't be read
			return {};
		}

		// Return cache if file hasn't changed
		if (fileScoresCache !== null && mtime <= fileScoresMtime) {
			return fileScoresCache;
		}

		const content = readFileSync(MODELS_JSON_PATH, "utf-8");
		// Strip comments, but only outside quoted strings (so http:// isn't broken)
		const stripped = content.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) =>
			m[0] === '"' ? m : "",
		);
		const config = JSON.parse(stripped);

		const scores: Record<string, number> = {};
		for (const [_providerName, providerConfig] of Object.entries(
			config.providers ?? {},
		)) {
			const pc = providerConfig as { models?: Array<Record<string, unknown>> };
			if (!pc.models) continue;
			for (const modelDef of pc.models) {
				const id = modelDef.id as string | undefined;
				const intelligence = modelDef.intelligence;
				if (id && typeof intelligence === "number") {
					scores[id] = intelligence;
				}
			}
		}

		fileScoresCache = scores;
		fileScoresMtime = mtime;
		return scores;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Resolve intelligence score: models.json takes precedence, then built-in table
// ---------------------------------------------------------------------------
function getAaScore(modelId: string): number | undefined {
	const fileScores = loadFileScores();

	// 1. Exact match from models.json
	if (modelId in fileScores) return fileScores[modelId];

	// 2. Last path segment match from models.json
	const lastSegment = modelId.split("/").pop() ?? modelId;
	if (lastSegment in fileScores) return fileScores[lastSegment];

	// 3. Prefix match from models.json
	let best: string | undefined;
	let bestLen = 0;
	for (const key of Object.keys(fileScores)) {
		if (modelId.startsWith(key) && key.length > bestLen) {
			best = key;
			bestLen = key.length;
		}
	}
	if (best !== undefined) return fileScores[best];

	// --- Fallback to built-in table ---

	// 4. Exact match from built-in table
	if (modelId in BUILT_IN_SCORES) return BUILT_IN_SCORES[modelId];

	// 5. Last path segment from built-in table
	if (lastSegment in BUILT_IN_SCORES) return BUILT_IN_SCORES[lastSegment];

	// 6. Prefix match from built-in table
	best = undefined;
	bestLen = 0;
	for (const key of Object.keys(BUILT_IN_SCORES)) {
		if (modelId.startsWith(key) && key.length > bestLen) {
			best = key;
			bestLen = key.length;
		}
	}
	if (best !== undefined) return BUILT_IN_SCORES[best];

	return undefined;
}

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

function fmtScore(val: number | undefined | null): string {
	if (val === undefined || val === null) return "n.a.";
	return val.toFixed(1);
}

// ---------------------------------------------------------------------------
// Update the status bar with model info
// ---------------------------------------------------------------------------
function updateStatusBar(
	ctx: ExtensionContext,
	modelId: string,
	cost: { input: number; output: number },
	aaScore: string,
) {
	ctx.ui.setStatus(
		"model-cost",
		`🤖 ${modelId} [↑${fmtCost(cost.input)} ↓${fmtCost(cost.output)}/1M] AA:${aaScore}`,
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

		const aaScore = getAaScore(model.id);
		const aaStr = fmtScore(aaScore);
		updateStatusBar(ctx, model.id, model.cost, aaStr);
	});

	pi.on("model_select", async (event, ctx) => {
		const { model, source } = event;

		// Skip notifications on session restore to avoid noise
		if (source === "restore") {
			updateStatusBar(ctx, model.id, model.cost, fmtScore(getAaScore(model.id)));
			return;
		}

		// Build display label
		const label =
			model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;

		// Cost info from Pi's built-in model data
		const cost = model.cost;

		// AA intelligence score: models.json → built-in table → "n.a."
		const aaScore = getAaScore(model.id);
		const aaStr = fmtScore(aaScore);
		const fromFile = aaScore !== undefined && model.id in (loadFileScores() ?? {})
			? " (from models.json)"
			: aaScore !== undefined
				? ""
				: "";

		// Notification 1: model name
		ctx.ui.notify(`🧠 Model: ${label}`, "info");

		// Notification 2: cost + AA score
		setTimeout(() => {
			const costLine = `💰 Cost/1M tok: Input ${fmtCost(cost.input)} | Output ${fmtCost(cost.output)} | CacheRead ${fmtCost(cost.cacheRead)}`;
			ctx.ui.notify(`${costLine} | AA Intelligence: ${aaStr}${fromFile}`, "info");
		}, 300);

		// Status bar
		updateStatusBar(ctx, model.id, cost, aaStr);

		// Console log
		console.log(
			`[model-cost] ${event.previousModel?.id ?? "none"} → ${model.id} (${source})` +
				` | cost: in=${cost.input} out=${cost.output} cache=${cost.cacheRead}` +
				` | AA=${aaStr}`,
		);
	});

	// Register a /cost command for on-demand details
	pi.registerCommand("cost", {
		description: "Show current model cost and AA Intelligence Index",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "warning");
				return;
			}

			const label =
				model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
			const cost = model.cost;
			const aaScore = getAaScore(model.id);
			const aaStr = fmtScore(aaScore);

			const fileScores = loadFileScores();
			const source =
				aaScore !== undefined && model.id in fileScores
					? "models.json"
					: aaScore !== undefined
						? "built-in table"
						: "unavailable";

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
			msg += `📊 AA Intelligence Index v4.1: ${aaStr} (source: ${source})`;

			ctx.ui.notify(msg, "info");
		},
	});

}

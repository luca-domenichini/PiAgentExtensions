import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── config file paths ──────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// models.json is in the parent directory (agent/), not this extension folder
const MODELS_CONFIG_PATH = path.join(__dirname, "..", "models.json");

const DEFAULT_CONTEXT_WINDOW = 65536; // 64k

// ── types ──────────────────────────────────────────────────────────────

/** A model entry inside providers.lm-studio.models in Pi models.json. */
interface ProviderModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
  };
}

/** The lm-studio provider section inside Pi models.json. */
interface LmStudioProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ProviderModelEntry[];
  [key: string]: unknown;
}

/** Top-level Pi models.json shape. */
interface PiModelsFile {
  providers?: Record<string, LmStudioProvider>;
}

// ── reasoning detection heuristics ────────────────────────────────────

// Models whose id matches these patterns are assumed reasoning-capable.
const REASONING_PATTERNS = [
  /\bdeepseek\b.*\b(r1|reasoner|revision)\b/i,
  /\br1\b.*\bdeepseek\b/i,
  /\bqwq\b/i,
  /\bthinking\b/i,
  /\bthinkingcap\b/i,
  /\breasoning\b/i,
  /\breasoner\b/i,
  /\bmtp\b/i,
  /\bsteiner\b/i,
];

function isLikelyReasoningModel(modelId: string): boolean {
  return REASONING_PATTERNS.some((p) => p.test(modelId));
}

/**
 * Build a sensible thinkingLevelMap for a reasoning model using
 * LM Studio's OpenAI-compatible reasoning_effort values.
 *
 * - off   → null (reasoning cannot be fully disabled on most reasoning models)
 * - minimal → "low"
 * - low   → "low"
 * - medium → "medium"
 * - high  → "high"
 * - xhigh → "high"
 */
function defaultThinkingLevelMap(): Record<string, string | null> {
  return {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
  };
}

// ── file helpers ───────────────────────────────────────────────────────

function loadPiModelsConfig(): PiModelsFile {
  try {
    const data = fs.readFileSync(MODELS_CONFIG_PATH, "utf-8");
    return JSON.parse(data) as PiModelsFile;
  } catch {
    return {};
  }
}

function savePiModelsConfig(config: PiModelsFile): void {
  fs.writeFileSync(MODELS_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}


// ── extension ──────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const LM_STUDIO_BASE = "http://localhost:1234/v1";

  try {
    // ── 1. Fetch models from LM Studio ────────────────────────────────
    const response = await fetch(`${LM_STUDIO_BASE}/models`);
    if (!response.ok) {
      console.warn(
        `[lm-studio-dynamic] Failed to fetch models from LM Studio: ${response.status} ${response.statusText}`
      );
      return;
    }

    const payload = (await response.json()) as {
      data: Array<{ id: string; object: string; owned_by: string }>;
    };

    // Filter out non-chat models (embeddings, whisper, rerankers, etc.)
    const chatModels = payload.data.filter((m) => {
      const id = m.id.toLowerCase();
      return !(
        id.includes("embedding") ||
        id.includes("embed") ||
        id.includes("whisper") ||
        id.includes("rerank") ||
        id.includes("tts") ||
        id.includes("stt")
      );
    });

    if (chatModels.length === 0) {
      console.warn("[lm-studio-dynamic] No chat-capable models found in LM Studio.");
      return;
    }

    // ── 2. Load / build the Pi models.json provider section ───────────
    const piConfig = loadPiModelsConfig();
    const providers = piConfig.providers ?? {};
    let lmStudioProvider = providers["lm-studio"];

    if (!lmStudioProvider) {
      lmStudioProvider = {
        baseUrl: LM_STUDIO_BASE,
        api: "openai-completions",
        apiKey: "lm-studio",
        models: [],
      };
      providers["lm-studio"] = lmStudioProvider;
    }
    if (!lmStudioProvider.models) {
      lmStudioProvider.models = [];
    }

    // Build a set of current chat model IDs from LM Studio
    const currentModelIds = new Set(chatModels.map((m) => m.id));

    // ── 3b. Remove models no longer provided by LM Studio ────────────
    const removedModels = lmStudioProvider.models.filter(
      (m) => !currentModelIds.has(m.id)
    );
    if (removedModels.length > 0) {
      lmStudioProvider.models = lmStudioProvider.models.filter((m) =>
        currentModelIds.has(m.id)
      );
      console.log(
        `[lm-studio-dynamic] Removed ${removedModels.length} stale model(s) no longer in LM Studio: ${removedModels.map((m) => m.id).join(", ")}`
      );
    }

    // Index existing model entries by id for fast lookup
    const existingModelMap = new Map<string, ProviderModelEntry>(
      lmStudioProvider.models.map((m) => [m.id, m])
    );

    const newModels: ProviderModelEntry[] = [];

    // ── 3. Process each chat model ────────────────────────────────────
    for (const model of chatModels) {
      const existingEntry = existingModelMap.get(model.id);

      // --- determine reasoning ---
      // Respect existing entry in models.json; otherwise auto-detect
      const reasoning =
        existingEntry?.reasoning ?? isLikelyReasoningModel(model.id);

      // --- compat ---
      const supportsDeveloperRole =
        existingEntry?.compat?.supportsDeveloperRole ?? true;
      const supportsReasoningEffort =
        existingEntry?.compat?.supportsReasoningEffort ?? reasoning;

      // --- thinkingLevelMap (only for reasoning models) ---
      const thinkingLevelMap: Record<string, string | null> | undefined =
        reasoning
          ? (existingEntry?.thinkingLevelMap ?? defaultThinkingLevelMap())
          : undefined;

      // --- contextWindow ---
      const contextWindow =
        existingEntry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

      // --- build the model entry for Pi models.json ---
      const modelEntry: ProviderModelEntry = {
        id: model.id,
        reasoning,
        contextWindow,
        compat: {
          supportsDeveloperRole,
          supportsReasoningEffort,
        },
      };
      if (thinkingLevelMap) {
        modelEntry.thinkingLevelMap = thinkingLevelMap;
      }

      // --- update or insert in provider models array ---
      if (existingEntry) {
        // Merge: keep user-set compat fields, update reasoning if it
        // was previously undefined, and add thinkingLevelMap if missing.
        const idx = lmStudioProvider.models.indexOf(existingEntry);
        if (idx !== -1) {
          lmStudioProvider.models[idx] = {
            ...existingEntry,
            reasoning: existingEntry.reasoning ?? reasoning,
            contextWindow: existingEntry.contextWindow ?? contextWindow,
            compat: {
              supportsDeveloperRole,
              supportsReasoningEffort,
              ...existingEntry.compat,
            },
            ...(thinkingLevelMap && !existingEntry.thinkingLevelMap
              ? { thinkingLevelMap }
              : {}),
          };
        }
      } else {
        lmStudioProvider.models.push(modelEntry);
        newModels.push(modelEntry);
      }
    }

    // ── 4. Write models.json ────────────────────────────────────────
    savePiModelsConfig({ providers });

    if (newModels.length > 0) {
      console.log(
        `[lm-studio-dynamic] Added ${newModels.length} new model(s) to models.json: ${newModels.map((m) => m.id).join(", ")}`
      );
    }

    // ── 5. Log summary ────────────────────────────────────────────────
    const modelSummaries = lmStudioProvider.models.map((m) => {
      const r = m.reasoning ?? false;
      const ctx = m.contextWindow ?? "?";
      const dev = m.compat?.supportsDeveloperRole ?? true;
      const effort = m.compat?.supportsReasoningEffort ?? r;
      return `${m.id} (ctx:${ctx}, reasoning:${r}, devRole:${dev}, effort:${effort})`;
    });

    console.log(
      `[lm-studio-dynamic] Found ${lmStudioProvider.models.length} chat model(s):\n  ` +
        modelSummaries.join("\n  ")
    );
  } catch (err) {
    console.warn(
      `[lm-studio-dynamic] Could not connect to LM Studio at ${LM_STUDIO_BASE}. Is it running?`
    );
    console.warn(
      `[lm-studio-dynamic] Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

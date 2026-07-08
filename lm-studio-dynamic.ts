import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── config file path ──────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_CONFIG_PATH = path.join(__dirname, "lm-studio-models.json");
const DEFAULT_CONTEXT_WINDOW = 65536; // 64k

// ── types ──────────────────────────────────────────────────────────────
interface ModelSettings {
  contextWindow: number;
}

interface ModelsConfig {
  models: Record<string, ModelSettings>;
}

// ── helpers ────────────────────────────────────────────────────────────
function loadModelsConfig(): ModelsConfig {
  try {
    const data = fs.readFileSync(MODELS_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(data) as ModelsConfig;
    if (parsed && typeof parsed.models === "object") {
      return parsed;
    }
    console.warn(`[lm-studio] Invalid config format, starting fresh.`);
    return { models: {} };
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      // file doesn't exist yet – fine
      return { models: {} };
    }
    console.warn(`[lm-studio] Could not read models config: ${err}`);
    return { models: {} };
  }
}

function saveModelsConfig(config: ModelsConfig): void {
  try {
    fs.writeFileSync(MODELS_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[lm-studio] Failed to write models config: ${err}`);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// ── extension ──────────────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
  const LM_STUDIO_BASE = "http://localhost:1234/v1";

  try {
    const response = await fetch(`${LM_STUDIO_BASE}/models`);
    if (!response.ok) {
      console.warn(`[lm-studio] Failed to fetch models: ${response.status} ${response.statusText}`);
      return;
    }

    const payload = (await response.json()) as {
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
      }>;
    };

    // Filter out non-chat models (embeddings, whisper, rerankers, etc.)
    const chatModels = payload.data.filter((m) => {
      const id = m.id.toLowerCase();
      if (
        id.includes("embedding") ||
        id.includes("embed") ||
        id.includes("whisper") ||
        id.includes("rerank") ||
        id.includes("tts") ||
        id.includes("stt")
      ) {
        return false;
      }
      return true;
    });

    if (chatModels.length === 0) {
      console.warn("[lm-studio] No chat-capable models found in LM Studio.");
      return;
    }

    // Load existing per-model settings, merge with newly discovered models
    const config = loadModelsConfig();
    const newModelIds: string[] = [];

    for (const model of chatModels) {
      if (!config.models[model.id]) {
        config.models[model.id] = {
          contextWindow: DEFAULT_CONTEXT_WINDOW,
        };
        newModelIds.push(model.id);
      }
    }

    // Persist any newly discovered models so the user can tweak them
    if (newModelIds.length > 0) {
      saveModelsConfig(config);
      console.log(
        `[lm-studio] Added ${newModelIds.length} new model(s) to ${path.basename(MODELS_CONFIG_PATH)}: ${newModelIds.join(", ")}`
      );
    }

    pi.registerProvider("lm-studio", {
      baseUrl: LM_STUDIO_BASE,
      apiKey: "lm-studio", // placeholder – LM Studio ignores auth
      api: "openai-completions",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: chatModels.map((model) => ({
        id: model.id,
        name: model.id,
        reasoning: false,
        input: ["text"] as ("text")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.models[model.id].contextWindow,
        maxTokens: 4096,
      })),
    });

    console.log(
      `[lm-studio] Registered ${chatModels.length} model(s): ${chatModels.map((m) => m.id).join(", ")}`
    );
  } catch (err) {
    console.warn(`[lm-studio] Could not connect to LM Studio at ${LM_STUDIO_BASE}. Is it running?`);
    console.warn(`[lm-studio] Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Dynamically discovers models from a local LM Studio instance
 * and registers them as a Pi provider.
 *
 * LM Studio exposes an OpenAI-compatible API at http://localhost:1234/v1.
 * This extension fetches the model list at startup so Pi always sees
 * whatever models you have loaded in LM Studio.
 */
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
      // Skip known non-chat model types
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

    // Heuristic: larger context for recent models, sensible default otherwise
    const guessContextWindow = (id: string): number => {
      const lower = id.toLowerCase();
      if (lower.includes("gemma-4") || lower.includes("llama-4")) return 262144;
      if (lower.includes("llama-3.1") || lower.includes("qwen2.5")) return 131072;
      if (lower.includes("deepseek") || lower.includes("mistral")) return 131072;
      return 32768; // safe conservative default
    };

    pi.registerProvider("lm-studio", {
      baseUrl: LM_STUDIO_BASE,
      apiKey: "lm-studio", // placeholder — LM Studio ignores auth
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
        contextWindow: guessContextWindow(model.id),
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

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Makes pi discover prompt templates from `.agents/prompts/` in the current
 * working directory, in addition to the built-in locations
 * (`~/.pi/agent/prompts/`, `.pi/prompts/`, packages, settings, CLI).
 *
 * This mirrors how pi already auto-scans `.agents/skills/` for skills, bringing
 * `.agents/prompts/` to parity. Drop `*.md` files into `.agents/prompts/` and
 * invoke them with `/<filename>` in the editor.
 *
 * The `resources_discover` event fires on startup and on `/reload`, so new or
 * edited prompts are picked up after a reload.
 */
export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", (event) => {
    return {
      promptPaths: [join(event.cwd, ".agents", "prompts")],
    };
  });
}

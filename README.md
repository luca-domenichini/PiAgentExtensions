# PiAgentExtensions

Extensions for [pi](https://github.com/earendil-works/pi). Drop a `.ts` file from this repo into `~/.pi/agent/extensions/` (or symlink it) and `/reload`.

| Extension | What it does | Command |
|---|---|---|
| `agents-prompts.ts` | Loads prompt templates from `.agents/prompts/` in the project | `/reload` to pick up |
| `fuzzy-file-mention.ts` | Fuzzy `@file` mentions | `@token` in the editor |
| `lm-studio-dynamic.ts` | Syncs local LM Studio models into `models.json` | — |
| `model-cost-display.ts` | Model cost in the footer + details on demand | `/cost` |
| `session-timer.ts` | Counts time the agent spends actually working | `/timer` |

## agents-prompts.ts

Makes pi discover `*.md` prompt templates from `.agents/prompts/` in the current working directory, in addition to the built-in locations (`~/.pi/agent/prompts/`, `.pi/prompts/`, packages, settings, CLI). Mirrors pi's existing auto-scan of `.agents/skills/`. Invoke with `/<filename>`. `resources_discover` fires on startup and `/reload`, so new or edited prompts are picked up after a reload.

## fuzzy-file-mention.ts

Fuzzy `@` completion: `@datadire` finds `Database/DatabaseDirectModule.cs`. The built-in provider only does literal-substring matching, so camel-case initials and skipped letters find nothing. This stacks a provider that:

- turns the token into a regex subsequence and runs `fd` (500 hits max, hidden files included, `.git` excluded) with a 2s timeout;
- ranks the hits with pi-tui's `fuzzyFilter`, scoring on the file name only (the repo path prefix would otherwise drown the real hit);
- offers up to 20 suggestions and quotes paths that contain spaces.

Requires `fd`/`fdfind` on `PATH` or in `~/.pi/agent/bin`; without it the extension warns once and leaves built-in completion in place. Tokens containing `/` or starting with `.`/`~` fall through to the built-in provider.

## lm-studio-dynamic.ts

On startup, fetches the model list from LM Studio (`http://localhost:1234/v1/models`), filters out non-chat models (embeddings, whisper, rerank, TTS/STT), and syncs them into the `providers["lm-studio"]` section of `~/.pi/agent/models.json`:

- adds models missing from the config;
- removes entries LM Studio no longer serves;
- keeps any values you already set (`contextWindow`, `compat`, `thinkingLevelMap`, `reasoning`) and only fills in gaps.

New entries default to a 64k context window and auto-detect reasoning support from the model id (`r1`, `qwq`, `thinking`, `reasoner`, …), mapping pi's thinking levels onto LM Studio's `reasoning_effort` values (`off` is mapped to `null` because most reasoning models can't disable it). If LM Studio isn't running, it logs a warning and changes nothing. Note it runs at startup and rewrites `models.json`, so keep the file in version control or a backup if you hand-tune it.

## model-cost-display.ts

Shows the active model's cost per 1M tokens in the footer (`🤖 [↑$3.00 ↓$15.00/1M]`), updates it on model switch, and prints a two-line notification with the model name and input/output/cacheRead pricing. Skipped on session restore to avoid noise.

`/cost` prints the full breakdown: provider, input, output, cacheRead, cacheWrite, and any tiered pricing (`>200,000 tok: in=… out=…`). Prices come from pi's built-in model data; missing values render as `n.a.`.

## session-timer.ts

Tracks cumulative time the agent spends actively processing — prompts, tool calls, retries, auto-compaction, follow-ups — shown in the footer as `⏳ 3m 42s`.

- `⏳` agent running, `⏸` blocked on a prompt (confirm/select/input/editor/custom), `⏱` idle.
- Idle time while you think or type is not counted; neither is time you spend answering a UI prompt.
- Accumulated time is persisted as a `session-timer-state` session entry, so it survives `/resume` and `/reload` of the same session.
- `/timer` prints total agent time plus session token usage (`↑1.2k ↓340`) and the current model.

No footer in print/JSON mode, where the timer is simply not displayed.

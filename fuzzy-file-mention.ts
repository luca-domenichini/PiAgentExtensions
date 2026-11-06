// Fuzzy `@` file mentions: `@datadire` finds `Database/DatabaseDirectModule.cs`.
// Built-in provider only does literal-substring matching against fd hits, so camel-case
// initials and skipped letters find nothing. This stacks a provider that treats the token
// as a subsequence and ranks the hits with pi-tui's fuzzyFilter.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

// fd returns its first MAX_HITS walk hits, so a very loose token (`@ddm`) can hide a better
// match past that cut; raise MAX_HITS if the picker ever misses a real file.
const MAX_HITS = 500;
const MAX_SUGGESTIONS = 20;
// `@`, optional quote, then a token of 2+ chars; only at a token boundary.
const AT_TOKEN = /(?:^|[\s=(\[{<`])(@"?)([^\s"@]{2,})$/;

/** fd matches this as a regex, so `datadire` becomes `d.*a.*t.*a.*.*d.*i.*r.*e`. */
function subsequencePattern(token: string): string {
	return token
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.split("")
		.join(".*");
}

/**
 * Split camelCase so fuzzy scoring rewards word starts, which is what `@datadire` hits.
 * Scored on the file name only: the repo prefix (`SmartStore.Automation.…`) matches any
 * vague subsequence and would otherwise bury the real hit.
 */
function boundaryText(path: string): string {
	return (path.split("/").pop() ?? path).replace(/([a-z0-9])([A-Z])/g, "$1-$2");
}

function findFd(): string | undefined {
	const names = process.platform === "win32" ? ["fd.exe", "fdfind.exe"] : ["fd", "fdfind"];
	const dirs = [
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
		join(homedir(), ".pi", "agent", "bin"),
	];
	for (const name of names) {
		for (const dir of dirs) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

function createProvider(
	current: AutocompleteProvider,
	fdPath: string,
	pi: ExtensionAPI,
	cwd: string,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const tokenMatch = beforeCursor.match(AT_TOKEN);
			const token = tokenMatch?.[2];
			// Scoped paths (`@dir/file`) and home paths stay with the built-in prefix provider.
			if (!tokenMatch || !token || /[/\\]/.test(token) || /^[.~]/.test(token)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const result = await pi.exec(
				fdPath,
				[
					"--max-results",
					String(MAX_HITS),
					"--type",
					"f",
					"--hidden",
					"--exclude",
					".git",
					subsequencePattern(token),
				],
				{ cwd, timeout: 2_000, signal: options.signal },
			).catch(() => undefined);
			if (!result || result.code !== 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const paths = result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const ranked = fuzzyFilter(paths, token, boundaryText).slice(0, MAX_SUGGESTIONS);
			if (ranked.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items: AutocompleteItem[] = ranked.map((path) => ({
				value: /\s/.test(path) ? `@"${path}"` : `@${path}`,
				label: path.split("/").pop() ?? path,
				description: path,
			}));
			return { items, prefix: `@${tokenMatch[1] === '@"' ? '"' : ""}${token}` };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	const fdPath = findFd();
	pi.on("session_start", (_event, ctx) => {
		if (!fdPath) {
			ctx.ui.notify("fuzzy-file-mention: fd not found, using built-in @ completion", "warning");
			return;
		}
		ctx.ui.addAutocompleteProvider((current) => createProvider(current, fdPath, pi, ctx.cwd));
	});
}

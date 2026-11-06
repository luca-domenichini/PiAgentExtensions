# PiAgentExtensions
Extensions for Pi agent

## Extensions

- **fuzzy-file-mention.ts** — fuzzy `@` file mentions: `@datadire` finds `Database/DatabaseDirectModule.cs`. Built-in completion only matches literal substrings; this one treats the token as a subsequence (`fd`) and ranks the hits with pi-tui's `fuzzyFilter`. Requires `fd`/`fdfind` on `PATH` (or in `~/.pi/agent/bin`); without it the extension notifies once and leaves built-in completion in place. Scoped paths (`@dir/file`) and `~`/`.` paths fall through to the built-in provider.

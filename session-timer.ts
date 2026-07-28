/**
 * Session Timer Extension
 *
 * Tracks cumulative time the agent spends actively processing
 * (running prompts, tool calls, retries, auto-compaction, follow-ups).
 * Does NOT count idle time while the user is typing or waiting.
 *
 * The time appears on the same line as "↑1.6k ↓160 0.0%/200k" via
 * ctx.ui.setStatus(), which Pi renders in the footer alongside
 * other extension statuses and the model name.
 *
 * Lifecycle:
 *   agent_start  ─► resume timer (if paused)
 *   agent_settled ─► pause timer, accumulate elapsed
 *   session_start ─► reset accumulator
 *   session_shutdown ─► clean up
 *
 * Format: "5s", "3m 42s", "1h 05m", "23h 59m"
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 0) return "0s";

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Timer state
// ---------------------------------------------------------------------------
const STATUS_KEY = "session-timer";

export default function (pi: ExtensionAPI) {
	// Accumulated active time from completed runs (ms)
	let accumulatedMs = 0;

	// Timestamp when the current active run started, or 0 if paused
	let runStartTime = 0;

	// Interval timer for updating the footer display
	let displayInterval: ReturnType<typeof setInterval> | null = null;

	// Cached ctx.ui.setStatus for use in the interval callback
	let setStatusFn: ((key: string, value: string | undefined) => void) | null = null;

	// -----------------------------------------------------------------------
	// Core timer logic
	// -----------------------------------------------------------------------

	/** Get the current effective elapsed time (accumulated + active run). */
	function getCurrentMs(): number {
		if (runStartTime > 0) {
			return accumulatedMs + (Date.now() - runStartTime);
		}
		return accumulatedMs;
	}

	/** Push the current active run duration into the accumulator and pause. */
	function pauseRun() {
		if (runStartTime > 0) {
			accumulatedMs += Date.now() - runStartTime;
			runStartTime = 0;
		}
	}

	/** Resume timing from the accumulated value (no-op if already running). */
	function resumeRun() {
		if (runStartTime === 0) {
			runStartTime = Date.now();
		}
	}

	/** Reset everything to zero. */
	function resetTimer() {
		pauseRun();
		accumulatedMs = 0;
	}

	// -----------------------------------------------------------------------
	// Footer display
	// -----------------------------------------------------------------------

	function updateDisplay() {
		if (!setStatusFn) return;
		const elapsed = getCurrentMs();
		const formatted = formatElapsed(elapsed);

		// Show a subtle pulse indicator when the agent is actively running
		const icon = runStartTime > 0 ? "⏳" : "⏱";
		setStatusFn(STATUS_KEY, `${icon}  ${formatted}`);
	}

	function startDisplay(ctx: ExtensionContext) {
		setStatusFn = ctx.ui.setStatus.bind(ctx.ui);
		updateDisplay();

		if (displayInterval) clearInterval(displayInterval);
		displayInterval = setInterval(updateDisplay, 1000);
	}

	function stopDisplay() {
		if (displayInterval) {
			clearInterval(displayInterval);
			displayInterval = null;
		}
		if (setStatusFn) {
			setStatusFn(STATUS_KEY, undefined);
			setStatusFn = null;
		}
	}

	// -----------------------------------------------------------------------
	// Extension events
	// -----------------------------------------------------------------------

	// Session lifecycle ── reset on new session, clean up on shutdown
	pi.on("session_start", async (_event, ctx) => {
		resetTimer();
		startDisplay(ctx);
	});

	pi.on("session_shutdown", async () => {
		pauseRun();
		stopDisplay();
	});

	// Agent lifecycle ── count only active processing time
	pi.on("agent_start", async () => {
		resumeRun();
		updateDisplay();
	});

	pi.on("agent_settled", async () => {
		pauseRun();
		updateDisplay();
	});

	// -----------------------------------------------------------------------
	// /timer command — show accumulated time with context
	// -----------------------------------------------------------------------

	pi.registerCommand("timer", {
		description: "Show accumulated agent processing time",
		handler: async (_args, ctx) => {
			const elapsed = getCurrentMs();
			const formatted = formatElapsed(elapsed);

			// Compute session token stats for richer output
			let input = 0,
				output = 0;
			for (const e of ctx.sessionManager.getBranch()) {
				if (e.type === "message" && e.message.role === "assistant") {
					const m = e.message as { usage?: { input?: number; output?: number } };
					input += m.usage?.input ?? 0;
					output += m.usage?.output ?? 0;
				}
			}

			const fmt = (n: number) =>
				n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;

			const model = ctx.model?.id ?? "none";
			const status = runStartTime > 0 ? " (agent running)" : "";
			ctx.ui.notify(
				`⏱ Agent time: ${formatted}${status}  |  ↑${fmt(input)} ↓${fmt(output)}  |  ${model}`,
				"info",
			);
		},
	});
}

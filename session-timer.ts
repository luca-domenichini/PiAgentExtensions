/**
 * Session Timer Extension
 *
 * Tracks cumulative time the agent spends actively processing
 * (running prompts, tool calls, retries, auto-compaction, follow-ups).
 * Does NOT count idle time while the user is typing or waiting, nor
 * time spent blocked on user-facing UI prompts (confirm/select/input/
 * editor/custom), reported via the ui_prompt_start/ui_prompt_end events.
 *
 * The time appears on the same line as "↑1.6k ↓160 0.0%/200k" via
 * ctx.ui.setStatus(), which Pi renders in the footer alongside
 * other extension statuses and the model name.
 *
 * Lifecycle:
 *   agent_start      ─► resume timer (if paused)
 *   ui_prompt_start  ─► pause timer (waiting for user), show ⏸
 *   ui_prompt_end    ─► resume timer (only if agent still running)
 *   agent_settled    ─► pause timer, accumulate elapsed, persist
 *   session_start    ─► restore accumulator ("resume"/"reload") or reset
 *   session_shutdown ─► pause, persist, clean up
 *
 * Persistence: accumulated time is saved as a custom session entry
 * ("session-timer-state") via pi.appendEntry() so it survives
 * /resume and /reload of the same session file.
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
const STATE_ENTRY_TYPE = "session-timer-state";

export default function (pi: ExtensionAPI) {
	// Accumulated active time from completed runs (ms)
	let accumulatedMs = 0;

	// Timestamp when the current active run started, or 0 if paused
	let runStartTime = 0;

	// True while a low-level agent run is in progress (agent_start..agent_settled)
	let agentRunning = false;

	// True while Pi is blocked on a user-facing UI prompt (coalesced by Pi)
	let waitingForUser = false;

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
	// Persistence
	// -----------------------------------------------------------------------

	function persistTimer() {
		pauseRun();
		pi.appendEntry(STATE_ENTRY_TYPE, { accumulatedMs });
	}

	function restoreTimer(ctx: ExtensionContext) {
		// Find the latest saved state on the current branch
		for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
			const entry = ctx.sessionManager.getBranch()[i];
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
				const data = entry.data as { accumulatedMs?: number } | undefined;
				if (typeof data?.accumulatedMs === "number") {
					accumulatedMs = data.accumulatedMs;
					return true;
				}
			}
		}
		return false;
	}

	// -----------------------------------------------------------------------
	// Footer display
	// -----------------------------------------------------------------------

	function updateDisplay() {
		if (!setStatusFn) return;
		const elapsed = getCurrentMs();
		const formatted = formatElapsed(elapsed);

		// ⏳ agent actively running · ⏸ blocked on a user prompt · ⏱ idle
		const icon = waitingForUser ? "⏸" : runStartTime > 0 ? "⏳" : "⏱";
		setStatusFn(STATUS_KEY, `${icon}  ${formatted}`);
	}

	function startDisplay(ctx: ExtensionContext) {
		if (!ctx.hasUI) return; // No footer in print/JSON mode

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

	// Session lifecycle ── restore on resume/reload, reset otherwise, clean up on shutdown
	pi.on("session_start", async (event, ctx) => {
		resetTimer();
		agentRunning = false;
		waitingForUser = false;
		if (event.reason === "resume" || event.reason === "reload") {
			restoreTimer(ctx);
		}
		startDisplay(ctx);
	});

	pi.on("session_shutdown", async () => {
		persistTimer();
		stopDisplay();
	});

	// Agent lifecycle ── count only active processing time
	pi.on("agent_start", async () => {
		agentRunning = true;
		resumeRun();
		updateDisplay();
	});

	pi.on("agent_settled", async () => {
		agentRunning = false;
		pauseRun();
		persistTimer();
		updateDisplay();
	});

	// User-facing prompts ── don't count time the user spends answering
	// (nested/overlapping prompts are coalesced by Pi into one outer span)
	pi.on("ui_prompt_start", async () => {
		waitingForUser = true;
		pauseRun();
		updateDisplay();
	});

	pi.on("ui_prompt_end", async () => {
		waitingForUser = false;
		// Only resume if the agent is still processing; a prompt may have
		// been the last thing before agent_settled, or fired while idle.
		if (agentRunning) {
			resumeRun();
		}
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
			const state = waitingForUser
				? " (waiting for user)"
				: runStartTime > 0
					? " (agent running)"
					: "";
			ctx.ui.notify(
				`⏱ Agent time: ${formatted}${state}  |  ↑${fmt(input)} ↓${fmt(output)}  |  ${model}`,
				"info",
			);
		},
	});
}

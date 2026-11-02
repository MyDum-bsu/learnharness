/**
 * THE TURN FUSE (turn-fuse wave, 2026-11-02): the teaching turn's upper
 * bound on tool calls and wall-clock time. A FUSE, not a limit — the owner
 * ruling 2026-09-25 (no maxTurns net on the teaching turn) stands: 100 tool
 * calls and 30 minutes sit far above a normal lesson, so a trip means the
 * turn was runaway (a repeating tool error burning tokens), and the only
 * honest outcome is a clean stop with the exact blocker.
 *
 * Pure policy: no I/O, no timers. The clock is injectable so tests pin the
 * deadline deterministically; the caller (teacher-agent.ts) owns the real
 * setTimeout and the abort. Once tripped, the fuse is FROZEN: the counter
 * stops at the limit, and every later observation returns the same trip —
 * the blocker and observed values are fixed by the first firing, and at
 * most one report reaches the caller per turn (teacher-agent guards the
 * callback; the fuse guarantees the values cannot drift).
 */

export const DEFAULT_MAX_TOOL_CALLS = 100;
export const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60_000;

export type FuseDimension = "tool_calls" | "wall_clock";

export interface FuseTrip {
	dimension: FuseDimension;
	/** What the fuse saw, clamped to the limit. */
	observed: number;
	limit: number;
	/** Stable, English, learner-facing:
	 *  `turn fuse tripped: tool_calls=<observed> limit=<limit>` or
	 *  `turn fuse tripped: wall_clock_ms=<observed> limit=<limit>`. */
	blocker: string;
}

export interface TurnFuse {
	/** Record tool-call elements observed for the turn (default 1). Returns
	 *  the frozen trip once the limit is reached, undefined before it. */
	observeToolCalls(count?: number): FuseTrip | undefined;
	/** Wall-clock check: trips at maxWallClockMs elapsed; later checks
	 *  return the same settled trip. */
	check(): FuseTrip | undefined;
	readonly toolCalls: number;
	readonly tripped: FuseTrip | undefined;
}

export function createTurnFuse(opts?: {
	maxToolCalls?: number;
	maxWallClockMs?: number;
	startedAt?: number;
	now?: () => number;
}): TurnFuse {
	const maxToolCalls = opts?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
	const maxWallClockMs = opts?.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS;
	const now = opts?.now ?? Date.now;
	const startedAt = opts?.startedAt ?? now();
	let calls = 0;
	let trip: FuseTrip | undefined;

	return {
		observeToolCalls(count = 1) {
			if (trip) return trip; // frozen — same blocker forever
			calls += count;
			if (calls >= maxToolCalls) {
				calls = maxToolCalls; // the counter freezes at the limit
				trip = {
					dimension: "tool_calls",
					observed: maxToolCalls,
					limit: maxToolCalls,
					blocker: `turn fuse tripped: tool_calls=${maxToolCalls} limit=${maxToolCalls}`,
				};
			}
			return trip;
		},
		check() {
			if (trip) return trip;
			if (now() - startedAt >= maxWallClockMs) {
				trip = {
					dimension: "wall_clock",
					observed: maxWallClockMs,
					limit: maxWallClockMs,
					blocker: `turn fuse tripped: wall_clock_ms=${maxWallClockMs} limit=${maxWallClockMs}`,
				};
			}
			return trip;
		},
		get toolCalls() {
			return calls;
		},
		get tripped() {
			return trip;
		},
	};
}

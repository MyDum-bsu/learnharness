/**
 * ORACLE — верхняя граница teaching-хода (turn fuse).
 *
 * Контракт (specs/<ID>.md, Intent):
 *   src/agent/turn-fuse.ts  — политика: tool calls + wall-clock, точный blocker, trip замирает.
 *   src/agent/teacher-agent.ts — finishTurn считает tool calls, wall-clock таймер абортит,
 *                                opts.onFuseTrip вызывается за ход ровно один раз.
 *
 * Проверяется в двух слоях:
 *   1) политика как чистый модуль (точные числа, 10k вызовов, дедлайн по инъекции часов);
 *   2) реальный `createTeacherAgent` на scripted faux engine — ран останавливается на пределе,
 *      usage собран, частичный транскрипт цел, нормальный длинный урок не задет.
 *
 * Тест НЕ трогает файловую систему и не поднимает сервер.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
// Two ups from oracle/<id>/ reach the repository root in every layout the
// oracle runs in (repo-root checkout, integration tree, task worktree).
import { createTeacherAgent } from "../../src/agent/teacher-agent.ts";
import type { PiEngine } from "../../src/agent/models.ts";
import {
	DEFAULT_MAX_TOOL_CALLS,
	DEFAULT_MAX_WALL_CLOCK_MS,
	createTurnFuse,
	type FuseTrip,
} from "../../src/agent/turn-fuse.ts";

const LIMIT = DEFAULT_MAX_TOOL_CALLS;
const DEADLINE = DEFAULT_MAX_WALL_CLOCK_MS;

const TOOL_BLOCKER = `turn fuse tripped: tool_calls=${LIMIT} limit=${LIMIT}`;
const CLOCK_BLOCKER = `turn fuse tripped: wall_clock_ms=${DEADLINE} limit=${DEADLINE}`;

/** Fuse default-конструктор: всё, что тест не задаёт, обязано быть дефолтом модуля. */
function fuse() {
	return createTurnFuse();
}

describe("turn fuse policy", () => {
	it("defaults are a fuse, not a low limit: 100 tool calls, 30 minutes", () => {
		assert.equal(LIMIT, 100, "DEFAULT_MAX_TOOL_CALLS must be the 100-call fuse from the request");
		assert.equal(DEADLINE, 30 * 60_000, "DEFAULT_MAX_WALL_CLOCK_MS must be 30 minutes");
	});

	it("does not trip on tool calls 1..99 and trips exactly on the 100th", () => {
		const f = fuse();
		const early: FuseTrip[] = [];
		for (let i = 1; i < LIMIT; i++) {
			const trip = f.observeToolCalls();
			if (trip) early.push(trip);
		}
		assert.deepEqual(early, [], `fuse fired before the limit (tool calls 1..${LIMIT - 1})`);

		const trip = f.observeToolCalls();
		assert.ok(trip, `fuse did not fire on tool call ${LIMIT}`);
		assert.equal(trip.dimension, "tool_calls");
		assert.equal(trip.observed, LIMIT);
		assert.equal(trip.limit, LIMIT);
		assert.equal(trip.blocker, TOOL_BLOCKER);
	});

	it("freezes at the limit: 10k calls stop at N, the blocker never changes", () => {
		const f = fuse();
		let firstTrip: FuseTrip | undefined;
		let tripCount = 0;
		for (let i = 0; i < 10_000; i++) {
			const trip = f.observeToolCalls();
			if (trip) {
				firstTrip ??= trip;
				tripCount++;
			}
		}
		assert.ok(firstTrip, "10k tool calls never tripped the fuse");
		assert.equal(firstTrip.observed, LIMIT, "the fuse must stop at N, not run to 10k");
		assert.equal(firstTrip.blocker, TOOL_BLOCKER);
		assert.equal(f.toolCalls, LIMIT, "the counter must freeze at the limit");
		assert.equal(f.tripped?.blocker, TOOL_BLOCKER, "the recorded trip must be stable");
		assert.equal(tripCount, 10_000 - LIMIT + 1, "every observation after the trip reports the same trip");
	});

	it("takes the limit as a parameter instead of hardcoding 100", () => {
		const f = createTurnFuse({ maxToolCalls: 3 });
		assert.equal(f.observeToolCalls(), undefined, "call 1 of a 3-call fuse must not trip");
		assert.equal(f.observeToolCalls(), undefined, "call 2 of a 3-call fuse must not trip");
		const trip = f.observeToolCalls();
		assert.ok(trip, "the 3rd call must trip a 3-call fuse");
		assert.equal(trip.limit, 3);
		assert.equal(trip.blocker, "turn fuse tripped: tool_calls=3 limit=3");
	});

	it("wall clock: silent one millisecond early, trips exactly at 30 minutes", () => {
		let clock = 1_000;
		const f = createTurnFuse({ now: () => clock });

		clock = 1_000 + DEADLINE - 1;
		assert.equal(f.check(), undefined, "fuse fired before the 30-minute deadline");

		clock = 1_000 + DEADLINE;
		const trip = f.check();
		assert.ok(trip, "fuse did not fire at the 30-minute deadline");
		assert.equal(trip.dimension, "wall_clock");
		assert.equal(trip.observed, DEADLINE);
		assert.equal(trip.limit, DEADLINE);
		assert.equal(trip.blocker, CLOCK_BLOCKER);

		clock = 1_000 + DEADLINE * 3;
		assert.equal(f.check()?.blocker, CLOCK_BLOCKER, "a later check must report the same, settled trip");
	});
});

/** A tool the faux model can call forever: it never poses a question, so nothing
 *  but the fuse can end the run. Error/any result shape keeps the loop going. */
function endlessTool(): unknown {
	return {
		name: "noop",
		label: "noop",
		description: "no-op tool (oracle)",
		parameters: {},
		executionMode: "sequential",
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

/** A faux engine that calls `noop` `steps` times and then answers with text. */
function loopingEngine(steps: number): PiEngine {
	const faux = createFauxCore({});
	const responses: FauxResponseStep[] = [];
	for (let i = 0; i < steps; i++) {
		responses.push(() =>
			fauxAssistantMessage([fauxToolCall("noop", {}, { id: `call-${i}` })], { stopReason: "toolUse" }),
		);
	}
	responses.push(() => fauxAssistantMessage([fauxText("done")]));
	faux.setResponses(responses);
	return { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
}

const SEED_MESSAGES = [
	{ id: "u1", role: "user", content: [{ type: "text", text: "teach me something long" }] },
] as unknown as never;

interface Harness {
	agent: { state: { messages: Array<{ content?: unknown }> } };
	trips: FuseTrip[];
	usages: unknown[];
}

function harness(steps: number): Harness {
	const trips: FuseTrip[] = [];
	const usages: unknown[] = [];
	const agent = createTeacherAgent(undefined, {
		engine: loopingEngine(steps),
		tools: { noop: endlessTool() as never },
		messages: SEED_MESSAGES,
		onUsage: (usage) => usages.push(usage),
		...( { onFuseTrip: (trip: FuseTrip) => trips.push(trip) } as Record<string, unknown> ),
	});
	return { agent: agent as unknown as Harness["agent"], trips, usages };
}

function countToolCalls(agent: Harness["agent"]): number {
	let calls = 0;
	for (const message of agent.state.messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if ((part as { type?: string }).type === "toolCall") calls++;
		}
	}
	return calls;
}

function countText(agent: Harness["agent"], needle: string): number {
	let hits = 0;
	for (const message of agent.state.messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.includes(needle)) hits++;
		}
	}
	return hits;
}

describe("turn fuse in a real teacher run", () => {
	it("stops a runaway turn at the limit with the exact blocker and keeps usage + transcript", async () => {
		const run = harness(500);
		await (run.agent as unknown as { continue: () => Promise<void> }).continue();

		assert.equal(run.trips.length, 1, `onFuseTrip must fire exactly once, got ${run.trips.length}`);
		const trip = run.trips[0]!;
		assert.equal(trip.dimension, "tool_calls");
		assert.equal(trip.limit, LIMIT);
		assert.equal(trip.observed, LIMIT);
		assert.equal(trip.blocker, TOOL_BLOCKER);

		assert.equal(countToolCalls(run.agent), LIMIT, "the run must stop exactly at the limit, not at 500");
		assert.ok(run.usages.length >= 1, "usage of the tripped turn must be collected (the money channel)");
		assert.ok(countText(run.agent, "teach me something long") >= 1, "the seeded transcript must survive the trip");
	});

	it("does not touch a normal long lesson (40 tool calls, well inside the fuse)", async () => {
		const run = harness(40);
		await (run.agent as unknown as { continue: () => Promise<void> }).continue();

		assert.deepEqual(run.trips, [], "the fuse must stay silent on a normal lesson");
		assert.equal(countToolCalls(run.agent), 40, "the normal lesson must run to its own end");
		assert.equal(countText(run.agent, "done"), 1, "the final answer must be present");
		assert.ok(run.usages.length >= 1, "usage of a normal lesson must still be collected");
	});
});

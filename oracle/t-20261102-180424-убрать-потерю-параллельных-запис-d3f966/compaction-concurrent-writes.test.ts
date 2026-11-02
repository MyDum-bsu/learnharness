/**
 * ORACLE — t-20261102-180424-убрать-потерю-параллельных-запис-d3f966.
 *
 * The law: a write applied to a chat between compaction's read of the
 * record and compaction's own write MUST survive. Today `compact()`
 * (src/server/compaction.ts) snapshots `record.messages`, awaits the
 * summarizer and then writes the stale snapshot back through
 * `ChatStore.saveMessages` (replace-whole), so everything written during
 * the await is silently lost.
 *
 * Shape of the test: the real fs chat store (temp LH_DATA_DIR, the
 * discipline of tests/compaction-service.test.ts) + an injected
 * summarizer behind a promise gate. While the gate is closed the test
 * writes the way the API routes write (read latest, append, save whole),
 * then releases the summarizer.
 *
 * Fails on the pre-fix code (the concurrent message disappears) and also
 * on the near-miss mutant in oracle/negative/<id>/kit.patch (it re-reads
 * the record but still writes the pre-await snapshot).
 *
 * Paths are resolved from the repository root by walking up from this
 * file, so the test runs both in place and from the worktree copy at
 * oracle/<id>/.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

function repoRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, "src", "server", "compaction.ts"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`oracle: cannot locate the repository root from ${import.meta.url}`);
}
const ROOT = repoRoot();
const load = (relative: string): Promise<any> => import(pathToFileURL(path.join(ROOT, relative)).href);

// ── the data seam, BEFORE any config-loading import (birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-oracle-concurrency-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await load("src/store/chats.ts");
const { ensureCompacted } = await load("src/server/compaction.ts");
const { activeCompactionOf, newUserMessage } = await load("src/core/index.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const USAGE = {
	input: 1_000,
	output: 500,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_500,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const big = (text: string, kb = 100): any => newUserMessage(`${text}: ${"x".repeat(kb * 1024)}`);

/** A chat whose record projects far over the test threshold, with a cut
 *  that leaves the recent tail in place (the ordinary compaction shape). */
function overThresholdChat(label: string): string {
	const chat = chatStore.createChat(label);
	chatStore.saveMessages(chat.id, [big("m1"), big("m2"), big("m3"), newUserMessage("recent")]);
	return chat.id;
}

function depsOf(summarize: (prompt: string, engine: unknown) => Promise<{ summary: string; usage: unknown }>): any {
	return {
		chatStore,
		// Never touched with an injected summarizer — only its identity
		// rides the marker's provenance.
		engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } },
		modelId: "faux:test",
		kind: "teach",
		thresholdTokens: 40_000,
		systemPromptTokens: 100,
		summarize,
	};
}

/** The summarizer held open by a promise gate, so the test controls the
 *  await window deterministically (no timers, no sleeps). */
function gatedSummarizer(summary = "SUMMARY: the learner knows X.") {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	return {
		started,
		release,
		summarize: async () => {
			entered();
			await gate;
			return { summary, usage: USAGE };
		},
	};
}

/** The route-style writer: read the LATEST record, mutate, save the whole
 *  array (app/api/chats/[id]/artifact-ui, .../dismiss). */
function writeLikeRoute(chatId: string, mutate: (messages: any[]) => any[]): void {
	const latest = chatStore.getChat(chatId);
	assert.ok(latest, `the chat ${chatId} exists`);
	chatStore.saveMessages(chatId, mutate([...latest.messages]));
}

const idsOf = (messages: any[]): string[] => messages.map((m) => m.id);
const compactionMarkers = (messages: any[]): any[] =>
	messages.filter((m) => (m as { customType?: string }).customType === "compaction");

// ── the laws ────────────────────────────────────────────────────────────────

describe("compaction never loses a write made while the summarizer runs", () => {
	it("a toggle-style write during the summarizer await survives the compaction", async () => {
		const chatId = overThresholdChat("oracle: toggle during compaction");
		const gate = gatedSummarizer();
		const running = ensureCompacted(depsOf(gate.summarize), chatId);
		await gate.started;

		const toggle = newUserMessage("artifact toggled: solved");
		toggle.id = "msg_artifact_toggle";
		writeLikeRoute(chatId, (messages) => [...messages, toggle]);
		assert.ok(
			idsOf(chatStore.getChat(chatId)!.messages).includes("msg_artifact_toggle"),
			"precondition: the concurrent write landed BEFORE compaction wrote",
		);

		gate.release();
		await running;

		const messages = chatStore.getChat(chatId)!.messages;
		assert.ok(
			idsOf(messages).includes("msg_artifact_toggle"),
			"the write made during the await survives compaction (a stale snapshot write would drop it)",
		);

		const marker = activeCompactionOf(messages);
		assert.ok(marker, "the compaction marker landed");
		assert.equal(compactionMarkers(messages).length, 1, "exactly one compaction marker for one run");

		const keptId = (marker as { details: { firstKeptMessageId: string } }).details.firstKeptMessageId;
		assert.ok(idsOf(messages).includes(keptId), "the marker's cut resolves to a message that exists");
	});

	it("two concurrent dismiss-style writes both survive one compaction", async () => {
		const chatId = overThresholdChat("oracle: two writers during compaction");
		const gate = gatedSummarizer();
		const running = ensureCompacted(depsOf(gate.summarize), chatId);
		await gate.started;

		const first = newUserMessage("problem dismissed: skip");
		first.id = "msg_dismiss_1";
		writeLikeRoute(chatId, (messages) => [...messages, first]);
		const second = newUserMessage("problem dismissed: skip again");
		second.id = "msg_dismiss_2";
		writeLikeRoute(chatId, (messages) => [...messages, second]);

		gate.release();
		await running;

		const messages = chatStore.getChat(chatId)!.messages;
		const ids = idsOf(messages);
		assert.ok(ids.includes("msg_dismiss_1"), "the first concurrent write survives");
		assert.ok(ids.includes("msg_dismiss_2"), "the second concurrent write survives");
		assert.ok(activeCompactionOf(messages), "the compaction marker landed next to them");
		assert.equal(compactionMarkers(messages).length, 1, "one marker, not one per writer");
	});

	it("a write after the compaction completed does not roll the marker back", async () => {
		const chatId = overThresholdChat("oracle: write after compaction");
		await ensureCompacted(
			depsOf(async () => ({ summary: "SUMMARY: settled.", usage: USAGE })),
			chatId,
		);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages), "precondition: the marker landed");

		const later = newUserMessage("written after the compaction finished");
		later.id = "msg_after_compaction";
		writeLikeRoute(chatId, (messages) => [...messages, later]);

		const messages = chatStore.getChat(chatId)!.messages;
		assert.ok(activeCompactionOf(messages), "a later writer keeps the marker (no rollback to a pre-await snapshot)");
		assert.ok(idsOf(messages).includes("msg_after_compaction"), "the later write landed");
	});

	it("an empty summary leaves the record untouched (an honest refusal, not a lost write)", async () => {
		const chatId = overThresholdChat("oracle: empty summary");
		const before = chatStore.getChat(chatId)!;
		await ensureCompacted(depsOf(async () => ({ summary: "   ", usage: USAGE })), chatId);
		const written = chatStore.getChat(chatId)!;
		assert.deepEqual(idsOf(written.messages), idsOf(before.messages), "the message list is unchanged");
		assert.equal(compactionMarkers(written.messages).length, 0, "no marker from an empty summary");
	});
});

/**
 * ATOMIC STORE WRITES (task t-20261102-180357): every whole-file store record
 * is replaced through `src/store/atomic-write.ts` — temp beside the target,
 * fsync, rename, dir fsync — so a process killed mid-save leaves the previous
 * COMPLETE record, and a record that exists but does not parse fails loudly
 * instead of reading as "first boot".
 *
 * The SIGKILL test re-executes THIS file as the crash child (LH_ATOMIC_CHAT
 * names the record) so the crash probe and the assertions share one seam.
 * Runs under an isolated LH_DATA_DIR set before any config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
// The crash child inherits the data dir via LH_ATOMIC_DATA; the test process
// creates the disposable one. Both then sit on the same LH_DATA_DIR seam.
const CRASH_CHAT = process.env.LH_ATOMIC_CHAT;
const TMP_DATA = process.env.LH_ATOMIC_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), "lh-store-atomic-"));
process.env.LH_DATA_DIR = TMP_DATA;
const CRASH_PASS = 500;

/** Child mode: persist the same chat over and over until SIGKILLed. Prints
 *  "writing"/"written" so the parent can time the kill inside a save. */
if (CRASH_CHAT) {
	const { chatStore } = await import("../src/store/chats.ts");
	const record = chatStore.getChat(CRASH_CHAT);
	if (!record) throw new Error(`crash child: chat ${CRASH_CHAT} not found`);
	const messages = record.messages;
	for (;;) {
		for (let k = 0; k < CRASH_PASS; k++) {
			messages.push({ id: `m_${messages.length}`, role: "user", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() });
		}
		process.stdout.write("writing\n");
		chatStore.saveMessages(CRASH_CHAT, messages);
		process.stdout.write("written\n");
	}
}

const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { jobStore } = await import("../src/store/jobs.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** SIGKILL the crash child `delayMs` after it announces the first save. */
function killDuringSave(chatId: string, delayMs: number): Promise<void> {
	const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename], {
		env: { ...process.env, LH_DATA_DIR: TMP_DATA, LH_ATOMIC_DATA: TMP_DATA, LH_ATOMIC_CHAT: chatId },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		child.stdout.on("data", (chunk) => {
			if (!timer && String(chunk).includes("writing")) {
				timer = setTimeout(() => child.kill("SIGKILL"), delayMs);
			}
		});
		child.on("error", reject);
		child.on("exit", (_code, signal) => {
			if (timer) clearTimeout(timer);
			if (signal !== "SIGKILL") {
				reject(new Error(`crash child exited without SIGKILL (signal=${signal}); stderr: ${stderr.slice(-600)}`));
				return;
			}
			resolve();
		});
	});
}

describe("store writes are replacements, not in-place truncations", () => {
	it("a chat save swaps the inode and leaves no temp behind", () => {
		const record = chatStore.createChat("atomic chat");
		const file = path.join(PATHS.chats, `${record.id}.json`);
		const before = fs.statSync(file).ino;
		chatStore.saveMessages(record.id, [
			{ id: "m_1", role: "user", content: [{ type: "text", text: "atomic" }], timestamp: Date.now() },
		]);
		assert.notEqual(fs.statSync(file).ino, before, "the chat file was rewritten in place");
		assert.deepEqual(
			fs.readdirSync(PATHS.chats).filter((f) => !f.endsWith(".json")),
			[],
			"a temp file survived the rename",
		);
		assert.equal(chatStore.getChat(record.id)?.messages.length, 1);
	});

	it("settings and job writes swap the inode too", () => {
		writeSettings({});
		const settingsBefore = fs.statSync(SETTINGS_FILE).ino;
		writeSettings({});
		assert.notEqual(fs.statSync(SETTINGS_FILE).ino, settingsBefore, "settings.json was rewritten in place");

		const chat = chatStore.createChat("atomic job");
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_atomic" });
		const jobFile = path.join(PATHS.data, "jobs", `${job.id}.json`);
		const jobBefore = fs.statSync(jobFile).ino;
		jobStore.updateJob(job.id, { activity: "still atomic" });
		assert.notEqual(fs.statSync(jobFile).ino, jobBefore, "the job file was rewritten in place");
		assert.deepEqual(
			fs.readdirSync(path.dirname(jobFile)).filter((f) => !f.endsWith(".json")),
			[],
			"a temp file survived the rename",
		);
	});

	it("SIGKILL during a chat save leaves a complete, parseable record", async () => {
		const record = chatStore.createChat("atomic crash");
		for (const delayMs of [0, 4, 9, 17]) {
			await killDuringSave(record.id, delayMs);
			const raw = fs.readFileSync(path.join(PATHS.chats, `${record.id}.json`), "utf-8");
			let parsed: { messages?: unknown[] };
			assert.doesNotThrow(() => {
				parsed = JSON.parse(raw) as { messages?: unknown[] };
			}, `chat ${record.id} is not parseable after SIGKILL (${raw.length} bytes)`);
			const saved = Array.isArray(parsed!.messages) ? parsed!.messages.length : -1;
			assert.ok(
				saved >= 0 && saved % CRASH_PASS === 0,
				`chat ${record.id} holds ${saved} messages after SIGKILL — not a completed save`,
			);
		}
	});
});

describe("a broken record fails loudly, an absent one reads as absent", () => {
	it("getChat throws naming the file; listChats skips it, logs it and keeps the rest", () => {
		const broken = chatStore.createChat("broken chat");
		const healthy = chatStore.createChat("healthy chat");
		const brokenId = broken.id;
		const brokenFile = path.join(PATHS.chats, `${brokenId}.json`);
		fs.writeFileSync(brokenFile, '{"id": "', "utf-8");

		assert.throws(
			() => chatStore.getChat(brokenId),
			(err: Error) => err instanceof Error && err.message.includes(`${brokenId}.json`),
			"a corrupt chat read returned instead of throwing",
		);

		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
		let listed: Awaited<ReturnType<typeof chatStore.listChats>>;
		try {
			listed = chatStore.listChats();
		} finally {
			console.error = original;
		}
		assert.ok(listed.some((c) => c.id === healthy.id), "the healthy chat must stay listed");
		assert.equal(listed.some((c) => c.id === brokenId), false, "the broken chat must be skipped");
		assert.ok(
			logged.some((line) => line.includes(`${brokenId}.json`)),
			`the skipped record was not logged; logged: ${JSON.stringify(logged)}`,
		);

		// A crash leftover (temp) is not a record: the directory scan ignores it.
		fs.writeFileSync(path.join(PATHS.chats, `.lh-tmp-${brokenId}.1.deadbeef`), "{}", "utf-8");
		assert.equal(chatStore.listChats().some((c) => c.id === brokenId), false);
	});

	it("readSettings throws on a corrupt file and still reads null when missing", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null, "an absent settings file is the first-boot state");
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		fs.writeFileSync(SETTINGS_FILE, "{ this is not json", "utf-8");
		assert.throws(
			() => readSettings(),
			(err: Error) => err instanceof Error && err.message.includes("settings.json"),
			"a corrupt settings read returned instead of throwing",
		);
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify(["not", "a", "record"]), "utf-8");
		assert.throws(() => readSettings(), /does not hold a settings object/);
		fs.rmSync(SETTINGS_FILE, { force: true });
	});

	it("getJob throws on a corrupt file, listJobs skips it and keeps the chat's other jobs", () => {
		const chat = chatStore.createChat("job isolation");
		const broken = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_broken" });
		const healthy = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_healthy" });
		const brokenFile = path.join(PATHS.data, "jobs", `${broken.id}.json`);
		fs.writeFileSync(brokenFile, "", "utf-8");

		assert.throws(
			() => jobStore.getJob(broken.id),
			(err: Error) => err instanceof Error && err.message.includes(`${broken.id}.json`),
			"a corrupt job read returned instead of throwing",
		);
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
		let listed: Awaited<ReturnType<typeof jobStore.listJobs>>;
		try {
			listed = jobStore.listJobs(chat.id);
		} finally {
			console.error = original;
		}
		assert.ok(listed.some((j) => j.id === healthy.id), "the healthy job stays listed");
		assert.equal(listed.some((j) => j.id === broken.id), false, "the broken job is skipped");
		assert.ok(
			logged.some((line) => line.includes(`${broken.id}.json`)),
			`the skipped job was not logged; logged: ${JSON.stringify(logged)}`,
		);
	});
});

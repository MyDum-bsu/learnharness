/**
 * Oracle for t-20261102-180357: every store write is atomic, and a corrupt
 * record read fails loudly.
 *
 * Four criteria, all behavioral:
 *  1. SIGKILL during a chat save (repeated per seed) never leaves an
 *     unparseable or partially written record.
 *  2. A store write replaces the target file (new inode) instead of
 *     truncating it in place — chats, settings, jobs.
 *  3. A corrupt record read raises an error naming the file; list reads
 *     skip the record and log it.
 *  4. Direct fs.writeFileSync lives in exactly one src/store module.
 *
 * Run: NODE_ENV=test npx tsx --test <this file>
 * Env: SEED (PBT seed), ATOMIC_CRASH_TRIALS (default 10).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

/** Walk up to the repository root (package.json + src/store): the oracle
 *  runs from a task workspace, a gate checkout or an integration tree, and
 *  those sit at different depths under .factory — a fixed climb cannot fit
 *  all three. */
function findRepoRoot(start: string): string {
	let dir = start;
	for (;;) {
		if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src/store"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`repository root (package.json + src/store) not found above ${start}`);
		dir = parent;
	}
}
const ROOT = findRepoRoot(import.meta.dirname);
const CHILD = path.join(import.meta.dirname, "crash-child.ts");

// The data directory seam is read once, at first import of config.ts, so it is
// fixed here — before any store module is loaded by a test body.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-store-atomic-"));
// @types/node types NODE_ENV readonly — the env write goes around the type.
Object.assign(process.env, { NODE_ENV: "test", LH_DATA_DIR: DATA_DIR });

type AnyApi = Record<string, any>;

/** Deterministic PRNG so one SEED reproduces one kill schedule. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function load(rel: string): Promise<AnyApi> {
	return (await import(pathToFileURL(path.join(ROOT, rel)).href)) as AnyApi;
}

/** Resolve a store port member: named export or member of the exported port
 *  object. An unknown module shape is a hard error, never a silent skip. */
function pick(ns: AnyApi, name: string): any {
	if (typeof ns[name] === "function") return ns[name];
	for (const key of Object.keys(ns)) {
		const value = ns[key];
		if (value && typeof value === "object" && typeof value[name] === "function") return value[name];
	}
	throw new Error(`store module does not expose ${name}(); exports: ${Object.keys(ns).join(", ")}`);
}

function saveChat(ns: AnyApi, id: string, messages: unknown[]): void {
	const saveMessages = pick(ns, "saveMessages");
	if (saveMessages.length >= 2) {
		saveMessages(id, messages);
		return;
	}
	if (saveMessages.length === 0) throw new Error("chats store saveMessages() declares no parameters; the oracle cannot drive it");
	const record = pick(ns, "getChat")(id);
	assert.ok(record, `chat ${id} not found before the second save`);
	saveMessages({ ...record, messages });
}

let seq = 0;
function jobInit(chatId: string): { kind: string; chatId: string; toolCallId: string } {
	seq += 1;
	return { kind: "researcher", chatId, toolCallId: `tc_oracle_${seq}` };
}

/** SIGKILL the child `delayMs` after it announces the first save. */
function killDuringSave(chatId: string, passMessages: number, delayMs: number): Promise<void> {
	const child = spawn(process.execPath, ["--import", "tsx", CHILD], {
		env: { ...process.env, LH_DATA_DIR: DATA_DIR, CRASH_CHAT_ID: chatId, CRASH_PASS_MESSAGES: String(passMessages) },
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

test("SIGKILL during a chat save leaves a complete, parseable record", async () => {
	const { PATHS } = await load("config.ts");
	const chats = await load("src/store/chats.ts");
	const createChat = pick(chats, "createChat");

	const seed = Number(process.env.SEED ?? "1");
	const trials = Number(process.env.ATOMIC_CRASH_TRIALS ?? "10");
	const random = mulberry32(Number.isFinite(seed) ? seed : 1);
	const passMessages = 2000;

	for (let trial = 0; trial < trials; trial += 1) {
		const record = createChat(`crash probe ${trial}`);
		const file = path.join(PATHS.chats, `${record.id}.json`);
		const delayMs = Math.floor(random() * 40);

		await killDuringSave(record.id, passMessages, delayMs);

		const raw = fs.readFileSync(file, "utf-8");
		let parsed: { messages?: unknown[] };
		try {
			parsed = JSON.parse(raw) as { messages?: unknown[] };
		} catch (err) {
			assert.fail(`chat ${record.id} is not parseable after SIGKILL (${raw.length} bytes): ${(err as Error).message}`);
		}
		const saved = Array.isArray(parsed.messages) ? parsed.messages.length : -1;
		assert.ok(
			saved >= 0 && saved % passMessages === 0,
			`chat ${record.id} holds ${saved} messages after SIGKILL — not a completed save (the target was truncated in place)`,
		);
	}
});

test("store writes replace the file instead of truncating it in place", async () => {
	const { PATHS, SETTINGS_FILE } = await load("config.ts");
	const chats = await load("src/store/chats.ts");
	const settings = await load("src/store/settings.ts");
	const jobs = await load("src/store/jobs.ts");

	const record = pick(chats, "createChat")("inode probe");
	const chatFile = path.join(PATHS.chats, `${record.id}.json`);
	const chatBefore = fs.statSync(chatFile).ino;
	saveChat(chats, record.id, [{ id: "m_inode", role: "user", content: [{ type: "text", text: "inode probe" }] }]);
	assert.notEqual(fs.statSync(chatFile).ino, chatBefore, `${chatFile} was rewritten in place`);

	const writeSettings = pick(settings, "writeSettings");
	writeSettings({});
	const settingsBefore = fs.statSync(SETTINGS_FILE).ino;
	writeSettings({});
	assert.notEqual(fs.statSync(SETTINGS_FILE).ino, settingsBefore, `${SETTINGS_FILE} was rewritten in place`);

	const job = pick(jobs, "createJob")(jobInit(record.id));
	const jobFile = path.join(PATHS.data, "jobs", `${job.id}.json`);
	const jobBefore = fs.statSync(jobFile).ino;
	pick(jobs, "updateJob")(job.id, { activity: "oracle probe" });
	assert.notEqual(fs.statSync(jobFile).ino, jobBefore, `${jobFile} was rewritten in place`);
});

test("a corrupt record read fails loudly and list reads log it", async () => {
	const { PATHS, SETTINGS_FILE } = await load("config.ts");
	const chats = await load("src/store/chats.ts");
	const settings = await load("src/store/settings.ts");
	const jobs = await load("src/store/jobs.ts");

	const record = pick(chats, "createChat")("corrupt probe");
	const chatFile = path.join(PATHS.chats, `${record.id}.json`);
	fs.writeFileSync(chatFile, '{"id": "', "utf-8");
	assert.throws(
		() => pick(chats, "getChat")(record.id),
		(err: Error) => err instanceof Error && err.message.includes(`${record.id}.json`),
		`reading a corrupt chat returned silently instead of an error naming ${record.id}.json`,
	);

	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map((arg) => String(arg)).join(" "));
	};
	let listed: unknown[];
	try {
		listed = pick(chats, "listChats")();
	} finally {
		console.error = originalError;
	}
	assert.ok(Array.isArray(listed), "listChats must still return a list");
	assert.ok(
		errors.some((line) => line.includes(`${record.id}.json`)),
		`listChats dropped the corrupt record without logging it; logged: ${JSON.stringify(errors)}`,
	);

	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, "{ this is not json", "utf-8");
	assert.throws(
		() => pick(settings, "readSettings")(),
		(err: Error) => err instanceof Error && err.message.includes("settings.json"),
		"reading a corrupt settings record returned null instead of an error naming settings.json",
	);

	const job = pick(jobs, "createJob")(jobInit(record.id));
	fs.writeFileSync(path.join(PATHS.data, "jobs", `${job.id}.json`), "", "utf-8");
	assert.throws(
		() => pick(jobs, "getJob")(job.id),
		(err: Error) => err instanceof Error && err.message.includes(`${job.id}.json`),
		`reading a corrupt job record returned silently instead of an error naming ${job.id}.json`,
	);
});

test("direct fs.writeFileSync lives in exactly one src/store module", async () => {
	const dir = path.join(ROOT, "src/store");
	const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"));
	assert.ok(files.length > 0, `no store modules found in ${dir}`);
	const direct = files.filter((file) => /\bwriteFileSync\s*\(/.test(fs.readFileSync(path.join(dir, file), "utf-8")));
	assert.equal(
		direct.length,
		1,
		`whole-file writes bypass the single atomic helper in: ${direct.length === 0 ? "(none — helper missing?)" : direct.join(", ")}`,
	);
});

/**
 * Crash probe child: repeatedly persists one chat record through the real
 * chats store adapter. The parent SIGKILLs this process at a random point
 * during a save; whatever is on disk afterwards must parse.
 *
 * Env: LH_DATA_DIR (set by the parent), CRASH_CHAT_ID, CRASH_PASS_MESSAGES.
 * Prints "writing <n>" before and "written <n>" after every save so the
 * parent can time the kill inside the write window.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Repository root by marker (package.json + src/store), not by a fixed climb:
// the oracle tree may sit at different depths under .factory.
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
const CHAT_ID = process.env.CRASH_CHAT_ID;
const PASS = Number(process.env.CRASH_PASS_MESSAGES ?? "2500");

if (!CHAT_ID) throw new Error("CRASH_CHAT_ID is not set");
if (!process.env.LH_DATA_DIR) throw new Error("LH_DATA_DIR is not set");
if (!Number.isInteger(PASS) || PASS <= 0) throw new Error(`CRASH_PASS_MESSAGES is not a positive integer: ${process.env.CRASH_PASS_MESSAGES}`);

type AnyApi = Record<string, any>;

/** Resolve a store port member: a named export, or a member of the exported
 *  port object (`chatStore` / `jobStore` / ...). No silent fallback: an
 *  unknown module shape is a hard error listing what is actually exported. */
function pick(ns: AnyApi, name: string): any {
	if (typeof ns[name] === "function") return ns[name];
	for (const key of Object.keys(ns)) {
		const value = ns[key];
		if (value && typeof value === "object" && typeof value[name] === "function") return value[name];
	}
	throw new Error(`store module does not expose ${name}(); exports: ${Object.keys(ns).join(", ")}`);
}

/** The chats port is (id, messages) or (record) depending on how it is
 *  declared; arity decides, and an undeclared signature is a hard error. */
function saveChat(ns: AnyApi, id: string, messages: unknown[]): void {
	const saveMessages = pick(ns, "saveMessages");
	if (saveMessages.length >= 2) {
		saveMessages(id, messages);
		return;
	}
	if (saveMessages.length === 0) throw new Error("chats store saveMessages() declares no parameters; the crash probe cannot drive it");
	const record = pick(ns, "getChat")(id);
	if (!record) throw new Error(`chat ${id} disappeared before the crash probe could save it`);
	saveMessages({ ...record, messages });
}

const ns = (await import(pathToFileURL(path.join(ROOT, "src/store/chats.ts")).href)) as AnyApi;
const record = pick(ns, "getChat")(CHAT_ID);
if (!record) throw new Error(`chat ${CHAT_ID} not found in ${process.env.LH_DATA_DIR}`);
const messages: unknown[] = Array.isArray(record.messages) ? [...record.messages] : [];

for (let pass = 0; pass < 200; pass++) {
	for (let k = 0; k < PASS; k++) {
		// Inflate the payload on purpose: a save of a few hundred bytes is too
		// short for an external kill to land inside the write syscalls.
		messages.push({ id: `m_${pass}_${k}`, role: "user", content: [{ type: "text", text: "x".repeat(400) }] });
	}
	process.stdout.write(`writing ${messages.length}\n`);
	saveChat(ns, CHAT_ID, messages);
	process.stdout.write(`written ${messages.length}\n`);
}

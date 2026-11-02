/**
 * THE STORE READ FRONT DOOR (atomic-store wave, 2026-11-02): whole-file JSON
 * loads for the record stores (chats, jobs, settings).
 *
 * "The file is not there" and "the file is broken" are different answers:
 * absence is the documented first-boot state (callers map it to null), while a
 * file that exists but cannot be read or parsed is an ERROR naming the file.
 * A silent null for a broken record would read as first boot and invite a
 * default-overwriting write on the next save — the corruption would be
 * laundered instead of surfaced.
 */

// Default import (CJS exports object), like every other store module — the
// tests' fs.readFileSync fault seams must reach this reader too.
import fs from "node:fs";

export type StoredJson = { present: false } | { present: true; value: unknown };

const ABSENT: StoredJson = { present: false };

export function readJsonFile(file: string): StoredJson {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
		throw new Error(`Store record ${file} is unreadable: ${(err as Error).message}`, { cause: err });
	}
	try {
		return { present: true, value: JSON.parse(raw) };
	} catch (err) {
		throw new Error(`Store record ${file} is not valid JSON: ${(err as Error).message}`, { cause: err });
	}
}

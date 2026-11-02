/**
 * THE STORE'S ONLY WHOLE-FILE WRITER (atomic-store wave, 2026-11-02).
 *
 * A store record is replaced, never truncated in place: a unique temp file
 * beside the target, write + fsync of the temp, rename over the target, then
 * fsync of the directory so the rename itself survives a power cut. A SIGKILL
 * between any two steps leaves either the previous complete file or the new
 * complete file on the target path — never a torn record. `fs.writeFileSync`
 * on a store target is a bug (the oracle counts the modules that still do it).
 *
 * Temp placement is part of the contract:
 *  - same directory — rename across filesystems is a copy, not atomic;
 *  - never a `.json` suffix (the extension is stripped) — directory scans
 *    (listChats, listJobs, listOverrides) read records by suffix and must
 *    never mistake a crash leftover for a record.
 */

// Default import, like every other store module: the fault-injection seams
// in tests (fs.renameSync / fs.writeFileSync replacement) bind to the CJS
// exports object, and a namespace import would bypass them.
import fs from "node:fs";
import * as path from "node:path";

export interface AtomicWriteOptions {
	/** Final file mode, applied to the temp BEFORE the rename — a secret
	 *  record (auth.json) must never exist at the target path with a relaxed
	 *  umask-derived mode, not even for an instant. */
	mode?: number;
}

export function writeFileAtomic(file: string, data: string, options: AtomicWriteOptions = {}): void {
	const dir = path.dirname(file);
	const base = path.basename(file, path.extname(file));
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.lh-tmp-${base}.${process.pid}.${crypto.randomUUID()}`);
	try {
		const fd = fs.openSync(tmp, "wx", options.mode ?? 0o666);
		try {
			fs.writeFileSync(fd, data, "utf-8");
			if (options.mode !== undefined) fs.fchmodSync(fd, options.mode);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
		const dirFd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// The temp never got created, or the rename already consumed it.
			// The original failure is what the caller must see.
		}
		throw err;
	}
}

#!/usr/bin/env node
/**
 * Remove test-suite junk from the LIVE data dir (test-hygiene wave,
 * 2026-11-04). The whitelist is generated from the OFFICIAL app's data
 * dir — every chat file there is a real learner session; any chat in the
 * live data/ that is not in that list was minted by a test run.
 *
 *   node scripts/clean-test-data.mjs [--dry-run]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const live = process.env.LH_DATA_DIR ?? path.join(repo, "data");
const official = path.join(os.homedir(), ".config", "LearnHarness", "data", "chats");
const dryRun = process.argv.includes("--dry-run");

if (!fs.existsSync(official)) {
	console.error(`official data not found: ${official} — refusing to guess a whitelist`);
	process.exit(1);
}
const keep = new Set(fs.readdirSync(official).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
console.log(`whitelist: ${keep.size} real sessions`);

let removed = 0;
for (const file of fs.readdirSync(path.join(live, "chats"))) {
	if (!file.endsWith(".json")) continue;
	const id = file.slice(0, -5);
	if (keep.has(id)) continue;
	if (dryRun) {
		console.log("would remove:", id);
		continue;
	}
	fs.rmSync(path.join(live, "chats", file), { force: true });
	removed++;
}
let jobsRemoved = 0;
const jobsDir = path.join(live, "jobs");
if (fs.existsSync(jobsDir)) {
	for (const file of fs.readdirSync(jobsDir)) {
		try {
			const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
			if (job.chatId && !keep.has(job.chatId)) {
				if (!dryRun) fs.rmSync(path.join(jobsDir, file), { force: true });
				jobsRemoved++;
			}
		} catch {
			/* unreadable job: leave it */
		}
	}
}
console.log(dryRun ? "dry run only" : `removed ${removed} junk chats, ${jobsRemoved} stale jobs`);

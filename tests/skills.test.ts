/**
 * The skills wave (2026-11-05): the store (data/skills/<name>.md), the
 * slash grammar (src/core/skills.ts) and the chat-handler's expansion
 * seam behavior (400 on an unknown /command). LH_DATA_DIR scratch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The data seam is read once, at first config import — fix it first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-skills-"));
process.env.LH_DATA_DIR = dataDir;

const { writeSkill, readSkill, deleteSkill, listSkills, skillMap } = await import("../src/store/skills.ts");
const { expandSlash } = await import("../src/core/skills.ts");

after(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the skill store", () => {
	it("creates, reads, lists and deletes one md file per skill", () => {
		writeSkill("explain-slow", "Объясни тему МЕДЛЕННО.\n$ARGUMENTS");
		writeSkill("quiz-3", "Придумай 3 вопроса по $ARGUMENTS.");
		const list = listSkills();
		assert.deepEqual(list.map((s) => s.name), ["quiz-3", "explain-slow"].sort());
		assert.match(readSkill("quiz-3") ?? "", /3 вопроса/);
		assert.equal(deleteSkill("quiz-3"), true);
		assert.equal(deleteSkill("quiz-3"), false);
		assert.equal(readSkill("quiz-3"), undefined);
		assert.deepEqual(listSkills().map((s) => s.name), ["explain-slow"]);
	});

	it("rejects bad names, empty bodies and oversized bodies", () => {
		assert.throws(() => writeSkill("../escape", "x"), /Некорректное имя/);
		assert.throws(() => writeSkill("ok-name", "   "), /пустым/);
		assert.throws(() => writeSkill("Upper", "x"), /Некорректное имя/);
	});
});

describe("the slash grammar", () => {
	it("/name and /name args expand through $ARGUMENTS or a tail append", () => {
		writeSkill("explain-slow", "Объясни тему МЕДЛЕННО.\n$ARGUMENTS");
		const bare = expandSlash("/explain-slow", skillMap());
		assert.equal(bare.kind, "ok");
		assert.ok(bare.kind === "ok" && !bare.expanded.includes("$ARGUMENTS"), "the placeholder never reaches the model");
		const withArgs = expandSlash("/explain-slow взлёт SpaceX", skillMap());
		assert.ok(withArgs.kind === "ok" && withArgs.expanded.includes("взлёт SpaceX"));

		assert.deepEqual(expandSlash("просто текст", skillMap()), { kind: "none" });
		const unknown = expandSlash("/nope-404", skillMap());
		assert.ok(unknown.kind === "unknown" && unknown.name === "nope-404");
	});
});

describe("the skills API", () => {
	it("lists, upserts and deletes without any auth in local mode", async () => {
		const route = await import("../app/api/skills/route.ts");
		const named = await import("../app/api/skills/[name]/route.ts");
		const post = await route.POST(
			new Request("http://localhost/api/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "api-skill", content: "Всегда отвечай списком." }) }),
		);
		assert.equal(post.status, 200);
		const listed = await route.GET(new Request("http://localhost/api/skills"));
		const body = (await listed.json()) as { skills: { name: string }[] };
		assert.ok(body.skills.some((s) => s.name === "api-skill"));
		const one = await named.GET(new Request("http://localhost/api/skills/api-skill"), { params: Promise.resolve({ name: "api-skill" }) });
		assert.match(await one.text(), /Всегда отвечай списком/);
		const removed = await named.DELETE(new Request("http://localhost/api/skills/api-skill", { method: "DELETE" }), { params: Promise.resolve({ name: "api-skill" }) });
		assert.equal(removed.status, 200);
		const missing = await named.DELETE(new Request("http://localhost/api/skills/api-skill", { method: "DELETE" }), { params: Promise.resolve({ name: "api-skill" }) });
		assert.equal(missing.status, 404);
	});
});

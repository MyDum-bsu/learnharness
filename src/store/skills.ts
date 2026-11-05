import * as fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomic } from "./atomic-write.ts";

/**
 * THE SKILL STORE (skills wave, 2026-11-05): the learner's own prompt
 * library, harness-style — one Markdown file per skill at
 * data/skills/<name>.md, invoked as `/name [аргументы]` in the composer.
 * A skill body may carry a `$ARGUMENTS` placeholder that the invocation
 * argument replaces; without the placeholder the argument appends.
 */

export interface SkillEntry {
	name: string;
	updatedAt: string;
	contentLength: number;
}

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTENT_LIMIT = 200_000;

function skillsDir(): string {
	return path.join(PATHS.data, "skills");
}

function skillFile(name: string): string {
	return path.join(skillsDir(), `${name}.md`);
}

export function isValidSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/** The skill names on disk, sorted. Creates the dir lazily. */
function skillNames(): string[] {
	const dir = skillsDir();
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md") && isValidSkillName(f.slice(0, -3)))
		.map((f) => f.slice(0, -3))
		.sort();
}

export function listSkills(): SkillEntry[] {
	return skillNames().map((name) => {
		const stat = fs.statSync(skillFile(name));
		return { name, updatedAt: stat.mtime.toISOString(), contentLength: stat.size };
	});
}

/** The raw body, or undefined for a missing skill. */
export function readSkill(name: string): string | undefined {
	if (!isValidSkillName(name)) return undefined;
	if (!fs.existsSync(skillFile(name))) return undefined;
	const body = fs.readFileSync(skillFile(name), "utf8");
	return body.length > CONTENT_LIMIT ? body.slice(0, CONTENT_LIMIT) : body;
}

/** Create or overwrite a skill (the whole-file write is atomic). */
export function writeSkill(name: string, content: string): void {
	if (!isValidSkillName(name)) throw new Error(`Некорректное имя скилла "${name}" (a-z0-9 и дефис, до 40 символов)`);
	const body = typeof content === "string" ? content : String(content);
	if (!body.trim()) throw new Error("Скилл не может быть пустым");
	if (body.length > CONTENT_LIMIT) throw new Error(`Скилл слишком большой (> ${CONTENT_LIMIT} символов)`);
	fs.mkdirSync(skillsDir(), { recursive: true });
	writeFileAtomic(skillFile(name), body.endsWith("\n") ? body : `${body}\n`);
}

export function deleteSkill(name: string): boolean {
	if (!isValidSkillName(name)) return false;
	if (!fs.existsSync(skillFile(name))) return false;
	fs.rmSync(skillFile(name), { force: true });
	return true;
}

/** The name→body map the slash expansion reads (one fs scan). */
export function skillMap(): Map<string, string> {
	const map = new Map<string, string>();
	for (const name of skillNames()) {
		map.set(name, fs.readFileSync(skillFile(name), "utf8"));
	}
	return map;
}

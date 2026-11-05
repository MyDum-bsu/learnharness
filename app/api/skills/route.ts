import { adminAuthorized } from "@/src/server/remote-access.ts";
import { listSkills, readSkill, writeSkill } from "@/src/store/skills.ts";

export const dynamic = "force-dynamic";

/**
 * THE SKILLS LIBRARY API (skills wave, 2026-11-05): the learner's own
 * prompt library, harness-style — Markdown bodies at data/skills/<name>.md,
 * invoked as `/<name> аргументы` in ANY composer (desktop, mobile — the
 * server expands the slash before parsing, so a client needs no skill UI
 * to USE a skill). Management is owner-scoped: the library shapes prompts —
 * not something a paired phone rewrites.
 *
 *   GET  → 200 { skills: [{name, updatedAt, contentLength}] }
 *   POST { name, content } → 200 { name, updatedAt } | 400
 */

export async function GET(request: Request): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Skill management requires the owner's session or an admin token." }, { status: 403 });
	}
	return Response.json({ skills: listSkills() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Skill management requires the owner's session or an admin token." }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as { name?: unknown; content?: unknown } | null;
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	if (typeof body?.content !== "string" || !body.content.trim()) {
		return Response.json({ error: "content must be a non-empty string" }, { status: 400 });
	}
	try {
		writeSkill(name, body.content);
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}
	const updated = listSkills().find((skill) => skill.name === name);
	return Response.json(
		{ name, updatedAt: updated?.updatedAt ?? new Date().toISOString() },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

/** The editor's load: one body by name → GET /api/skills/<name>. */
export function skillBody(name: string): string {
	return readSkill(name) ?? "";
}

import { adminAuthorized } from "@/src/server/remote-access.ts";
import { deleteSkill, readSkill } from "@/src/store/skills.ts";

export const dynamic = "force-dynamic";

/**
 * One skill: GET echoes the body (the settings editor's load), DELETE
 * removes it. Management is owner-scoped (the skills library shapes the
 * teaching prompts).
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Skill management requires the owner's session or an admin token." }, { status: 403 });
	}
	const { name } = await ctx.params;
	const body = readSkill(name);
	if (body === undefined) return Response.json({ error: `No skill "${name}".` }, { status: 404 });
	return Response.json({ name, content: body }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Skill management requires the owner's session or an admin token." }, { status: 403 });
	}
	const { name } = await ctx.params;
	if (deleteSkill(name)) return Response.json({ status: "deleted" }, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: `No skill "${name}".` }, { status: 404 });
}

import { adminAuthorized } from "@/src/server/remote-access.ts";
import { revokeDevice } from "@/src/store/devices.ts";

export const dynamic = "force-dynamic";

/** Revoke one device (owner action): the record gets a revokedAt stamp and
 *  the device's very next request fails validation — no grace period. A
 *  pending pairing code for the device (if any) is the owner's separate
 *  cancel — codes are unassociated until exchanged. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Device management requires the owner's session or an admin token." }, { status: 403 });
	}
	const { id } = await ctx.params;
	if (revokeDevice(id)) return Response.json({ status: "revoked" }, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: "No such device (or already revoked)." }, { status: 404 });
}

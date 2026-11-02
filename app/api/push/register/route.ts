import { deviceOf } from "@/src/server/remote-access.ts";
import { pushConfigured } from "@/src/server/push.ts";
import { registerPushToken, unregisterPushForDevice } from "@/src/store/push.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/push/register — a PAIRED phone registers its APNs/FCM token
 * (push wave, 2026-11-02). The device token authenticates the call; the
 * registration binds to that device, so revocation cuts pushes with the
 * same stroke. When the server has no provider keys this is an EXPLICIT
 * 503 — a client learns registration is impossible, instead of believing
 * a silent success.
 *
 *   POST   body { platform: "ios" | "android", token: string } → 200
 *   DELETE → removes every registration of the calling device → 200
 */
export async function POST(request: Request): Promise<Response> {
	const device = deviceOf(request.headers);
	if (!device) {
		return Response.json({ error: "Pair this device first (a paired device token is required)." }, { status: 401 });
	}
	if (!pushConfigured()) {
		return Response.json(
			{ error: "Push is not configured on this server (APNS_* / FCM_SERVICE_ACCOUNT_JSON are unset)." },
			{ status: 503 },
		);
	}
	const body = (await request.json().catch(() => null)) as { platform?: unknown; token?: unknown } | null;
	const platform = body?.platform === "ios" ? "ios" : body?.platform === "android" ? "android" : null;
	if (!platform) return Response.json({ error: 'platform must be "ios" or "android"' }, { status: 400 });
	if (typeof body?.token !== "string" || !body.token.trim()) {
		return Response.json({ error: "token must be a non-empty string" }, { status: 400 });
	}
	try {
		const registration = registerPushToken(device.id, platform, body.token);
		return Response.json(
			{ status: "registered", platform: registration.platform, deviceId: device.id },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}
}

export async function DELETE(request: Request): Promise<Response> {
	const device = deviceOf(request.headers);
	if (!device) {
		return Response.json({ error: "Pair this device first (a paired device token is required)." }, { status: 401 });
	}
	const removed = unregisterPushForDevice(device.id);
	return Response.json({ status: "unregistered", removed }, { headers: { "Cache-Control": "no-store" } });
}

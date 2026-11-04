import { adminAuthorized } from "@/src/server/remote-access.ts";
import { listDevices, mintPairing, pendingPairingCodes, pruneExpiredPairings } from "@/src/store/devices.ts";

export const dynamic = "force-dynamic";

/** The owner's device list: paired devices (never token hashes) plus any
 *  pending pairing codes. Admin scope only — a mobile device cannot even
 *  see that other devices exist. */
export async function GET(request: Request): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Device management requires the owner's session or an admin token." }, { status: 403 });
	}
	pruneExpiredPairings();
	return Response.json(
		{ devices: listDevices(), pending: pendingPairingCodes() },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

/** Mint a one-time pairing code. Body: { scope: "admin" | "mobile", name }.
 *  The code lives 5 minutes, exchanges exactly once, and never touches
 *  disk. The deep link (learnharness://pair?...) is what a QR code will
 *  carry (the QR itself renders in the pairing client, p2-1). */
export async function POST(request: Request): Promise<Response> {
	if (!adminAuthorized(request.headers)) {
		return Response.json({ error: "Device management requires the owner's session or an admin token." }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as { scope?: unknown; name?: unknown; origin?: unknown } | null;
	const scope = body?.scope === "admin" ? "admin" : body?.scope === "mobile" ? "mobile" : null;
	if (!scope) return Response.json({ error: 'scope must be "admin" or "mobile"' }, { status: 400 });
	const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "New device";
	// The QR must carry the address the PHONE can reach. Behind a funnel the
	// proxy rewrites Host to localhost, so request.url cannot be trusted —
	// the desktop CLIENT knows its own window origin (the funnel URL) and
	// sends it; a declared http(s) origin wins, the request-derived one is
	// the fallback for direct/local use.
	let origin = new URL(request.url).origin;
	if (typeof body?.origin === "string") {
		try {
			const declared = new URL(body.origin);
			if (declared.protocol === "http:" || declared.protocol === "https:") origin = declared.origin;
		} catch {
			/* ignore a malformed origin — fall back to the request's */
		}
	}
	const minted = mintPairing(scope, name, origin);
	return Response.json(minted, { headers: { "Cache-Control": "no-store" } });
}

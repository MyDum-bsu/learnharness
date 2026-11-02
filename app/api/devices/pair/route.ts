import { exchangePairingCode } from "@/src/store/devices.ts";

export const dynamic = "force-dynamic";

/** The pairing exchange (public by design): the one-time code IS the
 *  credential, it burns on any exchange attempt, and it dies in 5 minutes.
 *  The response carries the device token ONCE — the server stores only its
 *  hash (src/store/devices.ts). */
export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
	const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
	if (!code) return Response.json({ error: "The pairing code is required." }, { status: 400 });
	const outcome = exchangePairingCode(code);
	if (!outcome.ok) {
		return Response.json(
			{ error: outcome.error === "expired" ? "The pairing code expired — mint a new one." : "Unknown pairing code." },
			{ status: outcome.error === "expired" ? 410 : 400 },
		);
	}
	return Response.json(outcome.result, { headers: { "Cache-Control": "no-store" } });
}

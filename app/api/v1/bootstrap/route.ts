import {
	compactionInFlight,
	isTurnRunning,
	listChats,
	modelCatalog,
	refreshConnectionCatalog,
	settingsStore,
} from "@/src/server";
import { serverModeEnabled } from "@/src/server/remote-access.ts";
import { MOBILE_API_VERSION } from "@/src/server/mobile-api.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/bootstrap — THE frozen mobile contract (mobile-api wave,
 * 2026-11-02): everything a freshly connected client needs in ONE response,
 * with no server-component dependency. The web UI keeps reading its
 * per-page routes; this endpoint is the phone's only entry point.
 *
 *   { version: "v1",
 *     server:  { mode: "server" | "local", apiVersion: "v1" },
 *     settings: UserSettings | null,
 *     chats:   ChatListItem[]   (the session picker's list, live flags),
 *     models:  catalog DTO      (same shape as GET /api/models) }
 *
 * v1 is frozen: fields may be ADDED (clients ignore unknown keys), never
 * removed or renamed — a breaking change becomes /api/v2.
 */
export async function GET(): Promise<Response> {
	// The catalog refresh is the same seam GET /api/models runs; it is a
	// no-op when connections are already fresh.
	await refreshConnectionCatalog();
	const chats = listChats().map((chat) => ({
		...chat,
		busy: isTurnRunning(chat.id),
		compacting: compactionInFlight(chat.id),
	}));
	return Response.json(
		{
			version: MOBILE_API_VERSION,
			server: { mode: serverModeEnabled() ? "server" : "local", apiVersion: MOBILE_API_VERSION },
			settings: settingsStore.readSettings(),
			chats,
			models: modelCatalog(),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}

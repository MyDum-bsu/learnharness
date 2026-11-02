import { deviceScope } from "./remote-access.ts";

/**
 * THE MOBILE API V1 SURFACE (mobile-api wave, 2026-11-02): the server
 * contract the phone client talks to. Two things live here — the scope
 * gates the plan requires (a paired phone may USE the app; it may not
 * rewrite provider keys, model slots, tool authority, prompt overrides, or
 * server-wide settings) and the CORS policy for the Expo WEB build.
 *
 * The bootstrap endpoint (app/api/v1/bootstrap) freezes the v1 DTO: one
 * response with settings/chats/models, so the client never depends on
 * server components. Native React Native has no origin and needs no CORS;
 * only declared LH_CORS_ORIGINS get preflights answered (tokens only —
 * cookies are deliberately not allowed cross-origin).
 */

export const MOBILE_API_VERSION = "v1";

/** Sections a paired phone MAY write. Everything else — models, agent
 *  (tool toggles + prompt switches + background model), chat defaults,
 *  claudeCode (CLI), general (server-wide) — is owner territory. */
export const MOBILE_SAFE_SETTINGS_SECTIONS = new Set(["appearance", "graph", "compaction", "dictation"]);

export function isMobileScope(headers: Headers): boolean {
	return deviceScope(headers) === "mobile";
}

/** 403 for the actions a paired phone must not perform; undefined when the
 *  caller is not a mobile-scope device (sessions, admin tokens, local). */
export function mobileRefusal(headers: Headers, action: string): Response | undefined {
	if (!isMobileScope(headers)) return undefined;
	return Response.json(
		{ error: `The paired phone cannot ${action}. Use the desktop app for that.` },
		{ status: 403, headers: { "Cache-Control": "no-store" } },
	);
}

/** CORS headers for a declared origin (LH_CORS_ORIGINS, comma-separated),
 *  or undefined. No credentials: mobile carries a bearer device token. */
export function corsHeadersFor(origin: string | null, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
	if (!origin) return undefined;
	const allowed = (env.LH_CORS_ORIGINS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!allowed.includes(origin)) return undefined;
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "authorization, content-type, if-match, x-learnharness-desktop",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
		"Cache-Control": "no-store",
	};
}

import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { appsOnlyAllowed, appsOnlyRefusal, isPublicPath, remoteRequestAuthorized, serverModeEnabled } from "./src/server/remote-access.ts";
import { corsHeadersFor } from "./src/server/mobile-api.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Server mode (LH_SERVER_PASSWORD set, src/server/remote-access.ts) also
 * gates pages: signed-out browsers are sent to /login, signed-out API calls
 * get 401. With LH_APPS_ONLY=1 on top, anything that isn't the desktop or
 * iPhone app is refused before sign-in. Without server mode, pages pass
 * straight through as before. */
export function proxy(request: NextRequest) {
	// CORS for declared origins (LH_CORS_ORIGINS — the Expo WEB build;
	// mobile-api wave, 2026-11-02). Preflights carry no credentials and are
	// answered before any auth gate; credentialed requests keep the gate and
	// receive the headers on whatever response comes back (401/403 included,
	// so the browser can read the error).
	const cors = corsHeadersFor(request.headers.get("origin"));
	// Only a DECLARED CORS preflight skips the gate — it carries no
	// credentials by design. Any other OPTIONS keeps the fail-closed path.
	if (request.method === "OPTIONS" && cors) return new NextResponse(null, { status: 204, headers: cors });
	const response = gate(request);
	if (cors) for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
	return response;
}

/** The auth/policy gate, unchanged by CORS: apps-only, server-mode sign-in,
 * then the desktop API capability. (Plain Response — appsOnlyRefusal
 * carries an HTML body.) */
function gate(request: NextRequest): Response {
	const { pathname, search } = request.nextUrl;
	const api = pathname.startsWith("/api/");
	if (!appsOnlyAllowed(request.headers)) return appsOnlyRefusal(api);
	if (serverModeEnabled() && !isPublicPath(pathname) && !remoteRequestAuthorized(request.headers)) {
		if (api) {
			return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
		}
		const login = new URL("/login", request.url);
		login.searchParams.set("next", pathname + search);
		return NextResponse.redirect(login);
	}
	if (api && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

// Everything except build assets and public files (fonts, worklets, icons).
export const config = { matcher: ["/((?!_next/static|_next/image|fonts/|worklets/|siwc/|favicon\\.ico).*)"] };

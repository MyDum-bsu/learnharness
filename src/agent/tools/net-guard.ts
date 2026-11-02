import * as dns from "node:dns";

/**
 * THE NETWORK GUARD (ssrf-guard wave, 2026-11-02): the one policy module for
 * the model-driven fetches (web_fetch, web_fetch_pdf). Whatever the model can
 * point the host at, the guard has already judged: https-only, no private/
 * loopback/link-local targets — by IP literal, by name, and by what the name
 * RESOLVES to, on every redirect hop, with the verified resolve pinned into
 * the connection (no rebinding window between check and dial).
 *
 * Fail-closed everywhere: an unparseable address blocks, a lookup with no
 * answers blocks, a hop over the redirect cap blocks. Every refusal is an
 * exception OUT of guardedFetch — the tools catch it and return it as an
 * error STRING (their contract: never throw into the agent loop).
 *
 * Pinning: undici (already in node_modules transitively) provides both the
 * fetch and the Dispatcher, so one package version does the dialing its own
 * policy-verified resolve fed. package.json is outside this wave's allowed
 * paths — promoting undici to a direct dependency is the owner's one-line
 * follow-up; a missing module fails LOUDLY here, never into a silent
 * unpinned fetch.
 */

export interface NetDeps {
	/** The resolver; default dns.lookup with { all: true }. */
	lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
	/** The transport; default undici fetch behind the pinned dispatcher. */
	transport?: typeof fetch;
	/** Extra request init (headers, signal) passed through per hop. */
	init?: RequestInit;
}

export const NET_GUARD_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface UndiciLike {
	fetch: typeof fetch;
	Agent: new (options: unknown) => { close?: () => void };
}

let undiciCache: UndiciLike | undefined;
async function undici(): Promise<UndiciLike> {
	undiciCache ??= (await import("undici")) as unknown as UndiciLike;
	return undiciCache;
}

// ── the address law ─────────────────────────────────────────────────────────

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4ToInt(ip: string): number | null {
	const m = V4.exec(ip);
	if (!m) return null;
	const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if (octets.some((o) => o > 255)) return null;
	return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

/** Private/reserved IPv4 ranges (spec list): 0/8, 10/8, 100.64/10, 127/8,
 *  169.254/16, 172.16/12, 192.168/16, 192.0.0/24, 192.0.2/24, 198.18/15,
 *  198.51.100/24, 203.0.113/24, multicast 224/4, reserved 240/4. */
function v4Blocked(n: number): boolean {
	// Bitwise ops yield SIGNED int32 — every masked value goes through
	// >>> 0 before the ===, or any address ≥ 128.0.0.0 compares negative
	// against the positive literal and silently slips through.
	return (
		(n >>> 24) === 0x00 ||
		(n >>> 24) === 10 ||
		((n & 0xffc00000) >>> 0) === 0x64400000 || // 100.64/10 (CGNAT)
		(n >>> 24) === 127 ||
		(n >>> 16) === 0xa9fe ||
		((n & 0xfff00000) >>> 0) === 0xac100000 || // 172.16/12
		(n >>> 16) === 0xc0a8 ||
		(n >>> 8) === 0xc00000 ||
		(n >>> 8) === 0xc00002 ||
		((n & 0xfffe0000) >>> 0) === 0xc6120000 || // 198.18/15
		(n >>> 8) === 0xc63364 ||
		(n >>> 8) === 0xcb0071 ||
		(n >>> 28) === 0xe ||
		(n >>> 28) === 0xf
	);
}

/** Parse an IPv6 literal into its 8 hextets, or null. */
function v6Groups(ip: string): number[] | null {
	if (!ip.includes(":")) return null;
	const parts = ip.split("::");
	if (parts.length > 2) return null;
	const head = parts[0] ? parts[0].split(":") : [];
	const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (parts.length === 2 ? missing < 0 : missing !== 0) return null;
	const groups = parts.length === 2 ? [...head, ...Array<string>(missing).fill("0"), ...tail] : [...head, ...tail];
	if (groups.length !== 8) return null;
	const nums = groups.map((g) => parseInt(g, 16));
	if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
	return nums;
}

/** ::1, ::, fc00::/7, fe80::/10, ff00::/8, and the IPv4-mapped forms
 *  (unwrapped into the IPv4 law — both dotted and hex tails). */
function v6Blocked(groups: number[]): boolean {
	if (groups.every((g) => g === 0)) return true; // "::" — unspecified
	// ::ffff:0:0/96 — IPv4-mapped
	if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
		return v4Blocked((((groups[6]! << 16) | groups[7]!) >>> 0));
	}
	// ::1 — loopback
	if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
	const g0 = groups[0]!;
	if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 — ULA
	if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
	if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 — multicast
	return false;
}

/** True when the address sits in a blocked range. Unparseable input fails
 *  closed. NOT a hostname check — names are judged by resolve + name rules. */
export function isBlockedAddress(ip: string): boolean {
	const raw = ip.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
	const v4 = v4ToInt(raw);
	if (v4 !== null) return v4Blocked(v4);
	if (raw.startsWith("::ffff:") && raw.slice(7).includes(".")) {
		const mapped = v4ToInt(raw.slice(7));
		return mapped === null ? true : v4Blocked(mapped); // malformed mapped form: fail closed
	}
	const groups = v6Groups(raw);
	if (groups === null) return true;
	return v6Blocked(groups);
}

// ── the URL law ─────────────────────────────────────────────────────────────

/** https-only + host rules, judged WITHOUT touching the network: IP literals
 *  go through the address law, DNS names through the private-name rules
 *  (localhost, *.localhost, *.local). Everything else passes here — its
 *  RESOLVE is judged by guardedFetch before any dial. */
export function assertUrlPolicy(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`invalid URL: ${input}`);
	}
	if (url.protocol !== "https:") throw new Error("only https is allowed");
	// WHATWG hostname serializes IPv6 WITH brackets — strip them (and the
	// trailing dot of "localhost.") before the literal/name judgment.
	const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	const isV6 = v6Groups(host) !== null;
	const isV4 = !isV6 && v4ToInt(host) !== null;
	if (isV6 || isV4) {
		if (isBlockedAddress(host)) throw new Error(`blocked address: ${host} is a private/loopback/link-local address`);
	} else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
		throw new Error(`blocked address: ${host} is a private/loopback name`);
	}
	return url;
}

async function defaultLookup(hostname: string): Promise<{ address: string; family: number }[]> {
	return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

// ── the guarded transport ───────────────────────────────────────────────────

/** fetch with the full policy: parse → policy → resolve → judge every
 *  address → dial THE SAME resolve (pinned) → follow redirects manually,
 *  re-running the whole chain per hop, ≤ NET_GUARD_MAX_REDIRECTS hops. */
export async function guardedFetch(input: string, deps?: NetDeps): Promise<Response> {
	const lookup = deps?.lookup ?? defaultLookup;
	// The DEFAULT transport is the ambient globalThis.fetch — existing tests
	// stub it, and a stub must keep being the transport. Pinning rides the
	// `dispatcher` RequestInit option: Node's fetch forwards it to its
	// undici core, and the agent's custom lookup dials the exact addresses
	// the policy verified (an injected test transport ignores it — tests
	// own their transport).
	const transport = deps?.transport ?? globalThis.fetch;
	let current = assertUrlPolicy(input);
	// One dispatcher per call; its lookup returns the exact addresses the
	// policy verified for the CURRENT hop (the loop reassigns them — hops
	// are strictly sequential).
	let pinned: { address: string; family: number }[] = [];
	let agent: { close?: () => void } | undefined;
	if (!deps?.transport) {
		const { Agent } = await undici();
		agent = new Agent({
			connect: {
				lookup: (
					_hostname: unknown,
					_options: unknown,
					cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
				) => {
					const primary = pinned[0];
					if (!primary) {
						cb(Object.assign(new Error(`no pinned address for ${current.hostname}`), { code: "EAI_AGAIN" }), "", 4);
						return;
					}
					cb(null, primary.address, primary.family);
				},
			},
		});
	}
	try {
		for (let hop = 0; ; hop++) {
			if (hop >= NET_GUARD_MAX_REDIRECTS) {
				throw new Error(`blocked address: too many redirects (> ${NET_GUARD_MAX_REDIRECTS})`);
			}
			pinned = (await lookup(current.hostname)).filter((a) => Boolean(a?.address));
			if (pinned.length === 0) {
				throw new Error(`blocked address: dns lookup returned no addresses for ${current.hostname}`);
			}
			const blocked = pinned.find((a) => isBlockedAddress(a.address));
			if (blocked) {
				throw new Error(`blocked address: ${current.hostname} resolves to a private/loopback/link-local address (${blocked.address})`);
			}
			const init = { redirect: "manual" as const, ...(deps?.init ?? {}) };
			const response = await transport(current, (agent ? { ...init, dispatcher: agent } : init) as RequestInit);
			if (!REDIRECT_STATUSES.has(response.status)) return response;
			const location = response.headers.get("location");
			if (!location) return response; // a 3xx without Location — hand it through
			try {
				await response.arrayBuffer(); // drain so the socket returns to the pool
			} catch {
				/* the redirect body is irrelevant; a read failure must not mask the policy */
			}
			current = assertUrlPolicy(new URL(location, current).toString()); // the same law per hop
		}
	} finally {
		if (agent?.close) agent.close();
	}
}

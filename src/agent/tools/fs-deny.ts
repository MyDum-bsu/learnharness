import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";

/**
 * THE FILE-ACCESS GUARD for the learner-filesystem tools (fs-deny wave,
 * 2026-11-02): one module owns the whole deny policy. Whatever a tool reads
 * is sent to the model provider, so credentials, other agents' transcripts
 * and the app's own private records never reach the tools — including via a
 * symlink planted in an ordinary directory.
 *
 * Order of operations is the contract (spec t-20261102-180424):
 *   normalize → realpath of the existing prefix → verdict → read/walk.
 * The verdict is fail-closed: when a path cannot be realpath'd, the check
 * falls back to the normalized literal path, so a nonexistent file inside a
 * denied area is still denied. `resolveSourcePath` stays pure — it maps an
 * argument to a path and never judges it; every tool consults this guard
 * before its first open, and walks consult `deniedReason` per entry (the
 * policy table lives ONLY here).
 *
 * Masking is the second half: `redactSecrets` scrubs key-like values from
 * legitimately read text, idempotently, so `capOutput` can apply it per line.
 */

/** The seams the guard is parameterized by. */
export interface DenyScope {
	home: string; // absolute path
	dataDir: string; // resolved LH_DATA_DIR, default <repo>/data
	authFile: string; // resolved LH_AUTH_FILE, default <repo>/auth.json
	extraDirs: string[]; // additional private roots (packed Electron userData), may be empty
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** home from os.homedir() (live, so tests can re-anchor it); dataDir/authFile
 *  from LH_DATA_DIR/LH_AUTH_FILE at call time — never frozen at import. */
export function defaultDenyScope(): DenyScope {
	const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(REPO_ROOT, "data");
	const authFile = process.env.LH_AUTH_FILE ? path.resolve(process.env.LH_AUTH_FILE) : path.join(REPO_ROOT, "auth.json");
	const extraDirs = process.env.LH_USER_DATA_DIR ? [path.resolve(process.env.LH_USER_DATA_DIR)] : [];
	return { home: os.homedir(), dataDir, authFile, extraDirs };
}

export interface AccessVerdict {
	allowed: boolean;
	reason?: string;
}

export class FileAccessDeniedError extends Error {
	override readonly name = "FileAccessDeniedError";
	readonly code = "file_access_denied";
}

/** `.env`, `.env.local`, `.env.production` — dotenv files hold secrets
 *  wherever they live. */
const ENV_BASENAME = /^\.env(\..*)?$/i;

/** App-private records by basename, wherever they sit. */
const APP_PRIVATE_BASENAMES = new Set([
	"auth.json",
	"chatgpt-credentials.json",
	"github-copilot-credentials.json",
	"xai-credentials.json",
]);

/** Home-relative deny rules: the path (relative to home) and the reason
 *  category. Segment-boundary matched — `~/.ssh2` is NOT `~/.ssh`. */
const HOME_RULES: { rel: string; reason: string }[] = [
	// credentials
	{ rel: ".ssh", reason: "credentials" },
	{ rel: ".aws", reason: "credentials" },
	{ rel: ".gnupg", reason: "credentials" },
	{ rel: ".netrc", reason: "credentials" },
	{ rel: ".npmrc", reason: "credentials" },
	{ rel: ".git-credentials", reason: "credentials" },
	{ rel: ".config/gh", reason: "credentials" },
	{ rel: ".config/gcloud", reason: "credentials" },
	{ rel: ".docker/config.json", reason: "credentials" },
	{ rel: ".kube/config", reason: "credentials" },
	// other agents' session transcripts and settings
	{ rel: ".claude", reason: "agent-transcripts" },
	{ rel: ".codex", reason: "agent-transcripts" },
	{ rel: ".gemini", reason: "agent-transcripts" },
];

/** Segment-boundary containment, case-insensitive (macOS/Windows are):
 *  equality counts as inside, `/a/b2` is not inside `/a/b`. */
function isWithin(parent: string, child: string): boolean {
	const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The pure policy: why this literal path is denied, or undefined. No I/O —
 *  walks call it per entry; checkPathAccess layers realpath on top. */
export function deniedReason(absolutePath: string, scope: DenyScope = defaultDenyScope()): string | undefined {
	const target = path.resolve(absolutePath);
	const base = path.basename(target).toLowerCase();
	if (ENV_BASENAME.test(base)) return "credentials";
	if (APP_PRIVATE_BASENAMES.has(base)) return "app-private";
	if (isWithin(scope.authFile, target)) return "app-private";
	for (const dir of [scope.dataDir, ...scope.extraDirs]) {
		if (isWithin(dir, target)) return "app-private";
	}
	for (const rule of HOME_RULES) {
		if (isWithin(path.join(scope.home, rule.rel), target)) return rule.reason;
	}
	return undefined;
}

/** realpath of the longest existing prefix of `p` (symlinks resolved for the
 *  existing part, the missing tail appended); falls back to `p` itself when
 *  nothing up to the root resolves. */
async function realExisting(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		/* walk up to the existing prefix */
	}
	const tail: string[] = [path.basename(p)];
	let dir = path.dirname(p);
	while (dir !== path.dirname(dir)) {
		try {
			const real = await fs.realpath(dir);
			return path.resolve(real, ...tail.reverse());
		} catch {
			tail.push(path.basename(dir));
			dir = path.dirname(dir);
		}
	}
	return p;
}

/** The verdict for a tool path: the normalized literal AND its realpath are
 *  both judged (a symlink may not launder a denied target); a symlinked
 *  home is judged against the real home too. */
export async function checkPathAccess(absolutePath: string, scope: DenyScope = defaultDenyScope()): Promise<AccessVerdict> {
	const literal = path.resolve(absolutePath);
	const real = await realExisting(literal);
	for (const candidate of [literal, real]) {
		const reason = deniedReason(candidate, scope);
		if (reason !== undefined) return { allowed: false, reason };
	}
	const realHome = await realExisting(scope.home);
	if (realHome !== scope.home) {
		const reason = deniedReason(real, { ...scope, home: realHome });
		if (reason !== undefined) return { allowed: false, reason };
	}
	return { allowed: true };
}

/** Throws FileAccessDeniedError when the path is denied; resolves otherwise. */
export async function assertPathAllowed(absolutePath: string, scope: DenyScope = defaultDenyScope()): Promise<void> {
	const verdict = await checkPathAccess(absolutePath, scope);
	if (!verdict.allowed) {
		throw new FileAccessDeniedError(`file access denied (${verdict.reason}): ${absolutePath}`);
	}
}

const REDACTED = "[redacted]";

/** Ordered scrubbers: PEM blocks first, then well-formed token formats,
 *  then the keyword rule (`password|secret|token|api_key` + value ≥ 12).
 *  Idempotent by construction — every replacement lands on the 10-char
 *  marker, which none of the patterns can match again. */
const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\n]*/g,
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bAKIA[A-Z0-9]{16}\b/g,
	/\bAIza[A-Za-z0-9_-]{35}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/((?:password|secret|token|api_?key)\s*[=:]\s*["']?)[^\s"'`,;)}\]]{12,}/gi,
];

/** Replaces key-like values with `[redacted]`, keeping key names and the
 *  surrounding text. Idempotent: redactSecrets(redactSecrets(x)) === redactSecrets(x). */
export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, (match, prefix?: string) => (prefix === undefined ? REDACTED : `${prefix}${REDACTED}`));
	}
	return out;
}

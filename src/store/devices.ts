import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { DEVICES_FILE, PATHS } from "../../config.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { readJsonFile } from "./read-json.ts";

/**
 * THE DEVICE REGISTRY (pairing wave, 2026-11-02): one JSON record at
 * data/devices.json (DEVICES_FILE) holding every paired device — the
 * replacement for the shared-password-only access of the first server
 * mode. Orca's model: the OWNER mints a one-time pairing code; the new
 * device exchanges the code for a scoped bearer token; the server stores
 * ONLY THE TOKEN'S HASH (a leaked registry never leaks usable tokens);
 * revocation is a timestamp on the record and takes effect on the next
 * request — no restart, no grace period.
 *
 * Scopes: "admin" (session-equivalent; the desktop app) and "mobile" (the
 * phone client — API access, but it can never mint pairings, manage
 * devices, or touch secrets; p1-3 wires the route-level scope gates).
 *
 * Pairing codes live in MEMORY, not on disk: single-process server, 5-minute
 * TTL, one exchange each. A process restart drops pending codes — pairing
 * just mints a fresh code.
 *
 * Record shape (atomic-write discipline — the whole file is replaced):
 * { version: 1, devices: DeviceRecord[] }
 */

export interface DeviceRecord {
	id: string; // stable device id (random hex)
	name: string; // owner-assigned label ("Pixel 9", "Laptop")
	scope: "admin" | "mobile";
	tokenHash: string; // sha256 hex of the bearer token — never the token
	createdAt: string; // ISO
	expiresAt?: string; // ISO — absent = no expiry
	revokedAt?: string; // ISO — revoked devices fail validation immediately
}

interface DevicesRecord {
	version: 1;
	devices: DeviceRecord[];
}

const CURRENT_VERSION = 1;
const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L — read-aloud safe
/** The mobile scope's default token lifetime (the desktop admin scope never expires). */
export const MOBILE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function emptyRecord(): DevicesRecord {
	return { version: CURRENT_VERSION, devices: [] };
}

function readRecord(): DevicesRecord {
	const stored = readJsonFile(DEVICES_FILE);
	if (!stored.present) return emptyRecord();
	const value = stored.value as DevicesRecord;
	if (!value || value.version !== CURRENT_VERSION || !Array.isArray(value.devices)) {
		throw new Error(`Device registry ${DEVICES_FILE} does not hold a v1 devices record`);
	}
	return value;
}

function writeRecord(record: DevicesRecord): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomic(DEVICES_FILE, JSON.stringify(record, null, "\t"));
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

// ── validation (the per-request hot path: one read, pure checks) ────────────

export interface ValidatedDevice {
	id: string;
	name: string;
	scope: "admin" | "mobile";
}

/** The token's one truth: hash it and look the hash up. Revocation and
 *  expiry are checked here, so a revoked device dies on its very next
 *  request without any cache to invalidate. */
export function deviceForToken(token: string | undefined, now = Date.now()): ValidatedDevice | undefined {
	if (!token) return undefined;
	const hash = sha256Hex(token);
	const device = readRecord().devices.find((d) => d.tokenHash === hash);
	if (!device) return undefined;
	if (device.revokedAt) return undefined;
	if (device.expiresAt && new Date(device.expiresAt).getTime() <= now) return undefined;
	return { id: device.id, name: device.name, scope: device.scope };
}

export function listDevices(): Omit<DeviceRecord, "tokenHash">[] {
	return readRecord().devices.map(({ tokenHash, ...safe }) => safe);
}

// ── pairing ─────────────────────────────────────────────────────────────────

interface PendingPairing {
	code: string;
	scope: "admin" | "mobile";
	name: string;
	createdAt: number;
}

const pendingPairings = new Map<string, PendingPairing>();

/** The owner (desktop session or an admin token) mints a one-time code.
 *  Returns the code and the deep-link payload a QR code will carry. */
export function mintPairing(
	scope: "admin" | "mobile",
	name: string,
	origin: string,
	now = Date.now(),
): { code: string; pairingUrl: string; expiresAt: string } {
	// A code readable aloud and typeable on a phone keyboard: 8 chars from a
	// 31-symbol alphabet — ~40 bits, plenty for a 5-minute one-shot.
	let code = "";
	const bytes = randomBytes(8);
	for (let i = 0; i < 8; i++) code += PAIRING_CODE_ALPHABET[bytes[i]! % PAIRING_CODE_ALPHABET.length];
	const record: PendingPairing = { code, scope, name, createdAt: now };
	pendingPairings.set(code, record);
	const pairingUrl = `learnharness://pair?server=${encodeURIComponent(origin)}&code=${code}`;
	return { code, pairingUrl, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() };
}

export interface PairingResult {
	deviceId: string;
	name: string;
	scope: "admin" | "mobile";
	token: string; // the ONE plaintext response — never stored
	expiresAt?: string;
}

export function exchangePairingCode(
	code: string,
	origin = "",
	now = Date.now(),
): { ok: true; result: PairingResult } | { ok: false; error: "invalid" | "expired" } {
	const pending = pendingPairings.get(code);
	if (!pending) return { ok: false, error: "invalid" };
	pendingPairings.delete(code); // one exchange, ever — even a failed one burns the code
	if (now - pending.createdAt > PAIRING_TTL_MS) return { ok: false, error: "expired" };

	const token = `lhdev_${randomBytes(32).toString("base64url")}`;
	const record = readRecord();
	const device: DeviceRecord = {
		id: randomBytes(12).toString("hex"),
		name: pending.name,
		scope: pending.scope,
		tokenHash: sha256Hex(token),
		createdAt: new Date(now).toISOString(),
		...(pending.scope === "mobile" ? { expiresAt: new Date(now + MOBILE_TOKEN_TTL_MS).toISOString() } : {}),
	};
	record.devices.push(device);
	writeRecord(record);
	return {
		ok: true,
		result: {
			deviceId: device.id,
			name: device.name,
			scope: device.scope,
			token,
			...(device.expiresAt ? { expiresAt: device.expiresAt } : {}),
		},
	};
}

/** Immediate, registry-level: the next request with this device's token
 *  fails validation. The pairing code (if one is pending) burns too. */
export function revokeDevice(deviceId: string): boolean {
	const record = readRecord();
	const device = record.devices.find((d) => d.id === deviceId);
	if (!device || device.revokedAt) return false;
	device.revokedAt = new Date().toISOString();
	writeRecord(record);
	return true;
}

/** The owner's "cancel" for a minted-but-not-yet-exchanged code. */
export function cancelPairing(code: string): boolean {
	return pendingPairings.delete(code);
}

export function pendingPairingCodes(): { code: string; name: string; scope: string; expiresAt: string }[] {
	const now = Date.now();
	return [...pendingPairings.values()].map((p) => ({
		code: p.code,
		name: p.name,
		scope: p.scope,
		expiresAt: new Date(p.createdAt + PAIRING_TTL_MS).toISOString(),
	}));
}

/** Prune pending pairings older than the TTL — housekeeping, not correctness
 *  (exchangePairingCode already refuses expired codes). */
export function pruneExpiredPairings(now = Date.now()): void {
	for (const [code, pending] of pendingPairings) {
		if (now - pending.createdAt > PAIRING_TTL_MS) pendingPairings.delete(code);
	}
}

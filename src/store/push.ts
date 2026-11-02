import * as fs from "node:fs";
import { PATHS, PUSH_FILE } from "../../config.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { readJsonFile } from "./read-json.ts";

/**
 * THE PUSH REGISTRY (push wave, 2026-11-02): where each paired device's
 * APNs/FCM token lives. data/push.json, atomic-write discipline like every
 * record store. A registration is keyed by the PROVIDER TOKEN (one row per
 * install) and carries the owning deviceId — the device registry remains
 * the authority on revocation.
 */

export interface PushRegistrationRecord {
	deviceId: string;
	platform: "ios" | "android";
	token: string;
	createdAt: string;
}

interface PushRecord {
	version: 1;
	registrations: PushRegistrationRecord[];
}

const CURRENT_VERSION = 1;
const TOKEN_MAX = 4096;

function readRecord(): PushRecord {
	const stored = readJsonFile(PUSH_FILE);
	if (!stored.present) return { version: CURRENT_VERSION, registrations: [] };
	const value = stored.value as PushRecord;
	if (!value || value.version !== CURRENT_VERSION || !Array.isArray(value.registrations)) {
		throw new Error(`Push registry ${PUSH_FILE} does not hold a v1 registrations record`);
	}
	return value;
}

function writeRecord(record: PushRecord): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomic(PUSH_FILE, JSON.stringify(record, null, "\t"));
}

export function pushRecipients(): PushRegistrationRecord[] {
	return readRecord().registrations;
}

/** Upsert by provider token (a re-register from the same install refreshes
 *  its row and its device binding). */
export function registerPushToken(deviceId: string, platform: "ios" | "android", token: string): PushRegistrationRecord {
	const trimmed = token.trim();
	if (!trimmed || trimmed.length > TOKEN_MAX) throw new Error("push token must be a non-empty string under 4KB");
	const record = readRecord();
	const existing = record.registrations.find((registration) => registration.token === trimmed);
	const now = new Date().toISOString();
	if (existing) {
		existing.deviceId = deviceId;
		existing.platform = platform;
	} else {
		record.registrations.push({ deviceId, platform, token: trimmed, createdAt: now });
	}
	writeRecord(record);
	return { deviceId, platform, token: trimmed, createdAt: existing?.createdAt ?? now };
}

/** Remove one provider token (dead-token pruning). */
export function unregisterPushToken(token: string): boolean {
	const record = readRecord();
	const before = record.registrations.length;
	record.registrations = record.registrations.filter((registration) => registration.token !== token);
	if (record.registrations.length === before) return false;
	writeRecord(record);
	return true;
}

/** Revocation hook: a revoked device loses every registration. */
export function unregisterPushForDevice(deviceId: string): number {
	const record = readRecord();
	const before = record.registrations.length;
	record.registrations = record.registrations.filter((registration) => registration.deviceId !== deviceId);
	const removed = before - record.registrations.length;
	if (removed > 0) writeRecord(record);
	return removed;
}

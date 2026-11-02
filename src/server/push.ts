import { createPrivateKey, sign } from "node:crypto";
import { deviceById } from "../store/devices.ts";
import {
	pushRecipients,
	unregisterPushForDevice,
	unregisterPushToken,
	type PushRegistrationRecord,
} from "../store/push.ts";

/**
 * PUSH DELIVERY (push wave, 2026-11-02): APNs (HTTP/2 + ES256 JWT) for
 * phones, FCM (HTTP v1 + service account) for Android, behind one seam so
 * tests drive a fake and the triggers stay provider-agnostic.
 *
 * Rules from the plan:
 *  - payload carries chatId (deep link target) + kind;
 *  - a revoked device gets nothing — the DEVICE registry is the authority,
 *    and its registrations are dropped on the revoke path;
 *  - missing provider keys are an EXPLICIT PushNotConfiguredError on the
 *    API path (the register route answers 503) and a logged error on the
 *    fire-and-forget trigger path — never a silent no-op;
 *  - a provider saying the token is gone (APNs 410/400, FCM 404/400)
 *    prunes that registration instead of retrying forever.
 *
 * Triggers (chat-handler / job runner):
 *   notifyTurnSettled(chatId, questionPending) — question vs turn-settled;
 *   notifyJobDone(chatId, kind, failed)       — background job finished.
 */

export type PushKind = "question" | "turn-settled" | "job-done";

export interface PushMessage {
	/** The deep-link target — every push belongs to a session. */
	chatId: string;
	kind: PushKind;
	title: string;
	body: string;
}

export interface PushRegistration {
	deviceId: string;
	platform: "ios" | "android";
	token: string;
}

export interface PushProvider {
	send(registration: PushRegistration, message: PushMessage): Promise<void>;
}

export class PushNotConfiguredError extends Error {
	override readonly name = "PushNotConfiguredError";
}

/** The provider says this token will never work again — prune it. */
export class PushTokenGoneError extends Error {
	override readonly name = "PushTokenGoneError";
}

type Env = Record<string, string | undefined>;

function apnsConfigured(env: Env): boolean {
	return Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
}

function fcmConfigured(env: Env): boolean {
	return Boolean(env.FCM_SERVICE_ACCOUNT_JSON);
}

export function pushConfigured(env: Env = process.env): boolean {
	return apnsConfigured(env) || fcmConfigured(env);
}

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

// ── APNs (HTTP/2, provider-token JWT) ──────────────────────────────────────

let apnsJwt: { token: string; at: number } | undefined;

function apnsProviderToken(env: Env): string {
	if (apnsJwt && Date.now() - apnsJwt.at < 45 * 60_000) return apnsJwt.token;
	const key = createPrivateKey((env.APNS_KEY_P8 ?? "").replace(/\\n/g, "\n"));
	const header = base64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
	const claims = base64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
	const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
	apnsJwt = { token: `${header}.${claims}.${signature}`, at: Date.now() };
	return apnsJwt.token;
}

async function sendApns(registration: PushRegistration, message: PushMessage, env: Env): Promise<void> {
	const http2 = await import("node:http2");
	const client = http2.connect("https://api.push.apple.com");
	try {
		const status = await new Promise<number>((resolve, reject) => {
			const request = client.request({
				":method": "POST",
				":path": `/3/device/${encodeURIComponent(registration.token)}`,
				authorization: `bearer ${apnsProviderToken(env)}`,
				"apns-topic": env.APNS_TOPIC!,
				"apns-push-type": "alert",
				"content-type": "application/json",
			});
			let code = 0;
			request.on("response", (headers) => {
				code = Number(headers[":status"] ?? 0);
			});
			request.on("error", reject);
			request.on("end", () => resolve(code));
			request.end(
				JSON.stringify({
					aps: { alert: { title: message.title, body: message.body }, sound: "default" },
					chatId: message.chatId,
					kind: message.kind,
				}),
			);
		});
		if (status === 410 || status === 400) throw new PushTokenGoneError(`apns ${status}`);
		if (status !== 200) throw new Error(`apns refused with HTTP ${status}`);
	} finally {
		client.close();
	}
}

// ── FCM (HTTP v1, service account) ─────────────────────────────────────────

interface ServiceAccount {
	client_email: string;
	private_key: string;
	project_id: string;
	token_uri: string;
}

let fcmOauth: { token: string; at: number } | undefined;

async function fcmAccessToken(account: ServiceAccount): Promise<string> {
	if (fcmOauth && Date.now() - fcmOauth.at < 50 * 60_000) return fcmOauth.token;
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const now = Math.floor(Date.now() / 1000);
	const claims = base64url(
		JSON.stringify({
			iss: account.client_email,
			scope: "https://www.googleapis.com/auth/firebase.messaging",
			aud: account.token_uri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), createPrivateKey(account.private_key)).toString("base64url");
	const response = await fetch(account.token_uri, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: `${header}.${claims}.${signature}`,
		}),
	});
	if (!response.ok) throw new Error(`fcm auth refused with HTTP ${response.status}`);
	const body = (await response.json()) as { access_token: string };
	fcmOauth = { token: body.access_token, at: Date.now() };
	return body.access_token;
}

async function sendFcm(registration: PushRegistration, message: PushMessage, env: Env): Promise<void> {
	const account = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON ?? "{}") as ServiceAccount;
	const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
		method: "POST",
		headers: { authorization: `Bearer ${await fcmAccessToken(account)}`, "content-type": "application/json" },
		body: JSON.stringify({
			message: {
				token: registration.token,
				notification: { title: message.title, body: message.body },
				data: { chatId: message.chatId, kind: message.kind },
			},
		}),
	});
	if (response.status === 404 || response.status === 400) throw new PushTokenGoneError(`fcm ${response.status}`);
	if (!response.ok) throw new Error(`fcm refused with HTTP ${response.status}`);
}

/** The production provider: routes by platform; a platform with no keys
 *  configured throws PushNotConfiguredError (explicit, never silent). */
export function defaultPushProvider(env: Env = process.env): PushProvider {
	return {
		async send(registration, message) {
			if (registration.platform === "ios") {
				if (!apnsConfigured(env)) {
					throw new PushNotConfiguredError("APNs is not configured (APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC)");
				}
				await sendApns(registration, message, env);
				return;
			}
			if (!fcmConfigured(env)) {
				throw new PushNotConfiguredError("FCM is not configured (FCM_SERVICE_ACCOUNT_JSON)");
			}
			await sendFcm(registration, message, env);
		},
	};
}

// ── delivery ───────────────────────────────────────────────────────────────

export interface PushDeps {
	/** Injected fake in tests; default = the APNs/FCM provider. */
	provider?: PushProvider;
	/** Injected recipients in tests; default = the registry. */
	recipients?: PushRegistrationRecord[];
}

/** Send one message to every live registered device. Revoked devices are
 *  skipped AND their registrations dropped; dead tokens are pruned on the
 *  PushTokenGoneError path. Unconfigured providers throw (the caller
 *  decides: the route 503s, the trigger logs). */
export async function sendPush(
	message: PushMessage,
	deps: PushDeps = {},
): Promise<{ sent: number; pruned: number; skipped: number }> {
	const provider = deps.provider ?? defaultPushProvider();
	const registrations = deps.recipients ?? pushRecipients();
	let sent = 0;
	let pruned = 0;
	let skipped = 0;
	for (const registration of registrations) {
		const device = deviceById(registration.deviceId);
		if (!device || device.revokedAt) {
			skipped += 1;
			unregisterPushForDevice(registration.deviceId);
			continue;
		}
		try {
			await provider.send(registration, message);
			sent += 1;
		} catch (error) {
			if (error instanceof PushTokenGoneError) {
				unregisterPushToken(registration.token);
				pruned += 1;
				continue;
			}
			// One device's provider failure must not block the others; the
			// failure is loud in the log.
			console.error(`[push] send failed for device ${registration.deviceId}:`, error);
		}
	}
	return { sent, pruned, skipped };
}

/** Fire-and-forget trigger: a turn settled, or a question waits. */
export function notifyTurnSettled(chatId: string, questionPending: boolean): void {
	void sendPush({
		chatId,
		kind: questionPending ? "question" : "turn-settled",
		title: questionPending ? "A question is waiting" : "Your lesson is ready",
		body: questionPending ? "Open LearnHarness to answer." : "The teacher finished this turn.",
	}).catch((error) => console.error("[push] turn notification failed:", error));
}

/** Fire-and-forget trigger: a background job finished (result or failure). */
export function notifyJobDone(chatId: string, kind: string, failed: boolean): void {
	void sendPush({
		chatId,
		kind: "job-done",
		title: failed ? "Background job failed" : "Background job finished",
		body: `The ${kind} job ${failed ? "failed — open the session for details." : "is ready in the session."}`,
	}).catch((error) => console.error("[push] job notification failed:", error));
}

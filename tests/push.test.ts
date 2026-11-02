/**
 * Tests for the push wave (2026-11-02): the registry (src/store/push.ts),
 * delivery with an injected provider (src/server/push.ts) and the register
 * route. No network — the provider is a fake that records messages; the
 * real APNs/FCM adapters stay on the production path (their request shapes
 * are pinned by types, not by these tests).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The data seam is read once, at first config import — fix it first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-push-"));
process.env.LH_DATA_DIR = dataDir;

const { PUSH_FILE } = await import("../config.ts");
const { mintPairing, exchangePairingCode, revokeDevice } = await import("../src/store/devices.ts");
const { pushRecipients, registerPushToken } = await import("../src/store/push.ts");
const { defaultPushProvider, sendPush, PushNotConfiguredError, PushTokenGoneError } = await import("../src/server/push.ts");
const registerRoute = await import("../app/api/push/register/route.ts");
const { deviceRoute } = { deviceRoute: await import("../app/api/devices/[id]/route.ts") };

function pairedDevice(scope: "mobile" | "admin" = "mobile"): { deviceId: string; token: string } {
	const minted = mintPairing(scope, "Push phone", "http://lan:3000");
	const outcome = exchangePairingCode(minted.code);
	assert.ok(outcome.ok);
	return { deviceId: outcome.ok ? outcome.result.deviceId : "", token: outcome.ok ? outcome.result.token : "" };
}

interface Sent { registration: { deviceId: string; platform: string; token: string }; message: { chatId: string; kind: string; title: string; body: string } }
function fakeProvider(): { sent: Sent[]; provider: { send: (registration: Sent["registration"], message: Sent["message"]) => Promise<void> } } {
	const sent: Sent[] = [];
	return {
		sent,
		provider: {
			async send(registration, message) {
				sent.push({ registration, message });
			},
		},
	};
}

after(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("push delivery", () => {
	it("delivers to live devices with the chatId in the payload", async () => {
		const device = pairedDevice();
		registerPushToken(device.deviceId, "android", "fcm-token-1");
		const { sent, provider } = fakeProvider();
		const outcome = await sendPush({ chatId: "chat-42", kind: "question", title: "A question is waiting", body: "Open it" }, { provider });
		assert.ok(outcome.sent >= 1, "the live device was reached");
		const delivered = sent.find((entry) => entry.message.chatId === "chat-42" && entry.message.kind === "question");
		assert.ok(delivered, "payload carries chatId + kind");
		assert.equal(delivered!.registration.platform, "android");
		assert.equal(delivered!.message.title, "A question is waiting");
	});

	it("a revoked device gets nothing and its registrations are dropped", async () => {
		const device = pairedDevice();
		registerPushToken(device.deviceId, "ios", "apns-token-revoked");
		assert.equal(revokeDevice(device.deviceId), true);
		const { sent, provider } = fakeProvider();
		const outcome = await sendPush({ chatId: "c", kind: "turn-settled", title: "t", body: "b" }, { provider });
		assert.equal(sent.some((entry) => entry.registration.token === "apns-token-revoked"), false, "revoked device not delivered");
		assert.equal(outcome.skipped >= 1, true);
		assert.equal(pushRecipients().some((registration) => registration.token === "apns-token-revoked"), false, "registration pruned");
	});

	it("a provider saying the token is gone prunes the registration", async () => {
		const device = pairedDevice();
		registerPushToken(device.deviceId, "android", "dead-token");
		const provider = {
			async send(registration: { token: string }) {
				if (registration.token === "dead-token") throw new PushTokenGoneError("fcm 404");
			},
		};
		const outcome = await sendPush({ chatId: "c", kind: "job-done", title: "t", body: "b" }, { provider });
		assert.equal(outcome.pruned, 1);
		assert.equal(pushRecipients().some((registration) => registration.token === "dead-token"), false);
	});

	it("an unconfigured provider is an explicit logged error on the trigger path", async () => {
		const previous = { ...process.env };
		for (const key of ["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "FCM_SERVICE_ACCOUNT_JSON"]) delete process.env[key];
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		};
		try {
			const device = pairedDevice();
			registerPushToken(device.deviceId, "android", "unconfigured-token");
			const outcome = await sendPush({ chatId: "c", kind: "turn-settled", title: "t", body: "b" });
			assert.equal(outcome.sent, 0);
			assert.ok(logged.some((line) => /not configured/i.test(line)), `explicit error logged; got: ${logged.join(" | ")}`);
			await assert.rejects(
				async () => defaultPushProvider().send({ deviceId: device.deviceId, platform: "ios", token: "t" }, { chatId: "c", kind: "turn-settled", title: "t", body: "b" }),
				PushNotConfiguredError,
			);
		} finally {
			console.error = original;
			Object.assign(process.env, previous);
		}
	});

	it("the register route requires a paired device and 503s without provider keys", async () => {
		const device = pairedDevice();
		const headers = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };
		// Push is unconfigured in this environment: registration is refused explicitly.
		const unconfigured = await registerRoute.POST(new Request("http://localhost/api/push/register", { method: "POST", headers, body: JSON.stringify({ platform: "android", token: "tok" }) }));
		assert.equal(unconfigured.status, 503);
		assert.match(((await unconfigured.json()) as { error: string }).error, /not configured/i);

		// No device token: refused.
		const anonymous = await registerRoute.POST(new Request("http://localhost/api/push/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "android", token: "tok" }) }));
		assert.equal(anonymous.status, 401);

		// With keys configured the registration lands; DELETE clears it.
		process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "x@example.test", private_key: "", project_id: "p", token_uri: "https://oauth2.googleapis.com/token" });
		try {
			const registered = await registerRoute.POST(new Request("http://localhost/api/push/register", { method: "POST", headers, body: JSON.stringify({ platform: "android", token: "live-token" }) }));
			assert.equal(registered.status, 200);
			assert.equal(pushRecipients().some((registration) => registration.token === "live-token"), true);
			const removed = await registerRoute.DELETE(new Request("http://localhost/api/push/register", { method: "DELETE", headers }));
			assert.equal(removed.status, 200);
			assert.equal(pushRecipients().some((registration) => registration.deviceId === device.deviceId), false);
		} finally {
			delete process.env.FCM_SERVICE_ACCOUNT_JSON;
		}
	});

	it("device revocation through the owner route also drops push registrations", async () => {
		const previous = process.env.LH_SERVER_PASSWORD;
		delete process.env.LH_SERVER_PASSWORD; // local operator = owner
		try {
			const device = pairedDevice();
			registerPushToken(device.deviceId, "android", "revoked-via-route");
			process.env.LH_API_TOKEN = "a".repeat(32);
			const response = await deviceRoute.DELETE(new Request(`http://localhost/api/devices/${device.deviceId}`, { method: "DELETE" }), { params: Promise.resolve({ id: device.deviceId }) });
			assert.equal(response.status, 200);
			assert.equal(pushRecipients().some((registration) => registration.token === "revoked-via-route"), false);
		} finally {
			delete process.env.LH_API_TOKEN;
			if (previous !== undefined) process.env.LH_SERVER_PASSWORD = previous;
		}
	});
});

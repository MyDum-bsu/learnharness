/**
 * Tests for the device pairing wave (2026-11-02): src/store/devices.ts —
 * the one-time pairing code → scoped device token lifecycle — and its
 * wiring through src/server/remote-access.ts (bearer validation, admin
 * gate, throttle buckets). Synthetic data dir; no network; server-mode
 * env is owned and restored per test.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// The data seam is read once, at first config import — fix it BEFORE any
// config-loading import (birth-stamp discipline).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-device-pairing-"));
process.env.LH_DATA_DIR = dataDir;

const { DEVICES_FILE } = await import("../config.ts");
const {
	cancelPairing,
	deviceForToken,
	exchangePairingCode,
	listDevices,
	mintPairing,
	pendingPairingCodes,
	revokeDevice,
} = await import("../src/store/devices.ts");
const {
	adminAuthorized,
	bearerAuthorized,
	loginThrottled,
	remoteRequestAuthorized,
	recordLoginFailure,
	throttleKey,
} = await import("../src/server/remote-access.ts");
const devicesRoute = await import("../app/api/devices/route.ts");
const pairRoute = await import("../app/api/devices/pair/route.ts");
const deviceRoute = await import("../app/api/devices/[id]/route.ts");

const OWNER_SESSION = "lh-session-cookie-placeholder"; // session tokens need env; routes run with server mode OFF here

after(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the pairing lifecycle", () => {
	it("mints a one-time code, exchanges it once, and the token authorizes immediately", () => {
		const minted = mintPairing("mobile", "Pixel 9", "http://192.168.1.10:3000");
		assert.match(minted.code, /^[A-HJ-KM-NP-Z2-9]{8}$/);
		assert.match(minted.pairingUrl, /^learnharness:\/\/pair\?server=http%3A%2F%2F192\.168\.1\.10%3A3000&code=/);
		assert.ok(pendingPairingCodes().some((p) => p.code === minted.code));

		const outcome = exchangePairingCode(minted.code);
		assert.ok(outcome.ok, "the fresh code exchanges");
		const { token, scope, deviceId, expiresAt } = outcome.ok ? outcome.result : ({} as never);
		assert.equal(scope, "mobile");
		assert.ok(expiresAt, "the mobile scope carries a token expiry");
		assert.match(token, /^lhdev_/);

		// The token authorizes; the registry holds only its hash.
		assert.equal(bearerAuthorized(new Headers({ authorization: `Bearer ${token}` })), true);
		assert.equal(deviceForToken(token)?.name, "Pixel 9");
		assert.ok(!fs.readFileSync(DEVICES_FILE, "utf8").includes(token), "the plaintext token never lands on disk");
		assert.equal(listDevices().some((d) => d.id === deviceId), true);

		// One exchange, ever: a replay burns.
		const replay = exchangePairingCode(minted.code);
		assert.deepEqual(replay, { ok: false, error: "invalid" });
	});

	it("an expired code refuses with a distinct error", () => {
		const minted = mintPairing("mobile", "Slow phone", "http://lan:3000");
		const outcome = exchangePairingCode(minted.code, "", Date.now() + 6 * 60_000);
		assert.deepEqual(outcome, { ok: false, error: "expired" });
	});

	it("revocation takes effect on the very next request", () => {
		const minted = mintPairing("mobile", "To revoke", "http://lan:3000");
		const outcome = exchangePairingCode(minted.code);
		assert.ok(outcome.ok);
		const token = outcome.ok ? outcome.result.token : "";
		assert.equal(bearerAuthorized(new Headers({ authorization: `Bearer ${token}` })), true);

		const deviceId = outcome.ok ? outcome.result.deviceId : "";
		assert.equal(revokeDevice(deviceId), true);
		assert.equal(revokeDevice(deviceId), false, "double revoke is a 404, not a second stamp");
		assert.equal(bearerAuthorized(new Headers({ authorization: `Bearer ${token}` })), false, "revoked device dies immediately");
	});

	it("an expired device token no longer authorizes", () => {
		const minted = mintPairing("mobile", "Old phone", "http://lan:3000");
		const outcome = exchangePairingCode(minted.code, "", Date.now() - 181 * 24 * 60 * 60 * 1000);
		assert.ok(outcome.ok, "the exchange succeeded — the token's own expiry is what matters");
		const token = outcome.ok ? outcome.result.token : "";
		assert.equal(bearerAuthorized(new Headers({ authorization: `Bearer ${token}` })), false, "the 180-day mobile token is stale");
	});

	it("scope gates: mobile cannot manage devices, admin can", () => {
		// The admin gate's server-mode-off branch means "local operator =
		// owner" — the gate only means something with server mode ON.
		process.env.LH_SERVER_PASSWORD = "test-password";
		process.env.LH_SESSION_SECRET = "test-session-secret";
		try {
			const mobile = mintPairing("mobile", "Phone", "http://lan:3000");
			const mobileOutcome = exchangePairingCode(mobile.code);
			const admin = mintPairing("admin", "Laptop", "http://lan:3000");
			const adminOutcome = exchangePairingCode(admin.code);
			assert.ok(mobileOutcome.ok && adminOutcome.ok);
			const mobileToken = mobileOutcome.ok ? mobileOutcome.result.token : "";
			const adminToken = adminOutcome.ok ? adminOutcome.result.token : "";

			assert.equal(adminAuthorized(new Headers({ authorization: `Bearer ${mobileToken}` })), false);
			assert.equal(adminAuthorized(new Headers({ authorization: `Bearer ${adminToken}` })), true);
			assert.equal(remoteRequestAuthorized(new Headers({ authorization: `Bearer ${mobileToken}` })), true, "mobile still uses the API");
		} finally {
			delete process.env.LH_SERVER_PASSWORD;
			delete process.env.LH_SESSION_SECRET;
		}
	});

	it("a pending code can be cancelled before exchange", () => {
		const minted = mintPairing("mobile", "Cancelled", "http://lan:3000");
		assert.equal(cancelPairing(minted.code), true);
		assert.deepEqual(exchangePairingCode(minted.code), { ok: false, error: "invalid" });
	});
});

describe("the pairing routes", () => {
	it("management routes refuse a mobile token; the pair exchange is code-gated", async () => {
		// Server mode ON: the owner acts via the API token; the paired phone
		// (mobile scope) must not mint, list, or revoke.
		process.env.LH_SERVER_PASSWORD = "test-password";
		process.env.LH_SESSION_SECRET = "test-session-secret";
		process.env.LH_API_TOKEN = "a".repeat(32);
		const ownerHeaders = { authorization: `Bearer ${"a".repeat(32)}`, "content-type": "application/json" };
		try {
			const minted = mintPairing("mobile", "Phone", "http://lan:3000");
			const outcome = exchangePairingCode(minted.code);
			assert.ok(outcome.ok);
			const mobileToken = outcome.ok ? outcome.result.token : "";
			const mobileHeaders = { authorization: `Bearer ${mobileToken}`, "content-type": "application/json" };

			const mint = await devicesRoute.POST(new Request("http://localhost/api/devices", { method: "POST", headers: mobileHeaders, body: JSON.stringify({ scope: "mobile", name: "second" }) }));
			assert.equal(mint.status, 403, "a mobile device cannot mint pairings");
			const list = await devicesRoute.GET(new Request("http://localhost/api/devices", { headers: mobileHeaders }));
			assert.equal(list.status, 403, "a mobile device cannot list devices");

			const localMint = await devicesRoute.POST(new Request("http://localhost/api/devices", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ scope: "mobile", name: "Tablet" }) }));
			assert.equal(localMint.status, 200);
			const { code, pairingUrl } = (await localMint.json()) as { code: string; pairingUrl: string };
			assert.ok(pairingUrl.startsWith("learnharness://pair?"));

			const pair = await pairRoute.POST(new Request("http://localhost/api/devices/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.toLowerCase() }) }));
			assert.equal(pair.status, 200, "the exchange is case-insensitive on the code");
			const paired = (await pair.json()) as { token: string; deviceId: string };

			const bad = await pairRoute.POST(new Request("http://localhost/api/devices/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }));
			assert.equal(bad.status, 400, "the burned code refuses");

			const revoke = await deviceRoute.DELETE(new Request(`http://localhost/api/devices/${paired.deviceId}`, { method: "DELETE", headers: ownerHeaders }), { params: Promise.resolve({ id: paired.deviceId }) });
			assert.equal(revoke.status, 200);
			assert.equal(bearerAuthorized(new Headers({ authorization: `Bearer ${paired.token}` })), false);
			const gone = await deviceRoute.DELETE(new Request(`http://localhost/api/devices/${paired.deviceId}`, { method: "DELETE", headers: ownerHeaders }), { params: Promise.resolve({ id: paired.deviceId }) });
			assert.equal(gone.status, 404);
		} finally {
			delete process.env.LH_SERVER_PASSWORD;
			delete process.env.LH_SESSION_SECRET;
			delete process.env.LH_API_TOKEN;
		}
	});
});

describe("the throttle buckets", () => {
	beforeEach(() => {
		process.env.LH_TRUST_PROXY = undefined as never;
	});

	it("a directly exposed server throttles on ONE global bucket with the wider cap", () => {
		const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
		const bucket = throttleKey(headers);
		assert.equal(bucket.key, "direct", "XFF is not trusted without LH_TRUST_PROXY");
		assert.equal(bucket.max, 30);
		for (let i = 0; i < 29; i++) recordLoginFailure(bucket.key);
		assert.equal(loginThrottled(bucket.key, bucket.max), false);
		recordLoginFailure(bucket.key);
		assert.equal(loginThrottled(bucket.key, bucket.max), true);
	});

	it("behind a declared proxy, throttling is per real client address at 10", () => {
		process.env.LH_TRUST_PROXY = "1";
		const bucket = throttleKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
		assert.equal(bucket.key, "203.0.113.9");
		assert.equal(bucket.max, 10);
		for (let i = 0; i < 10; i++) recordLoginFailure(bucket.key);
		assert.equal(loginThrottled(bucket.key, bucket.max), true);
		const other = throttleKey(new Headers({ "x-forwarded-for": "198.51.100.7" }));
		assert.equal(loginThrottled(other.key, other.max), false, "another real address is untouched");
	});
});

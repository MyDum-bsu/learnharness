/**
 * Contract tests for the mobile API v1 (mobile-api wave, 2026-11-02):
 * app/api/v1/bootstrap (the frozen DTO), the CORS policy in proxy.ts, and
 * the scope gates (a paired phone cannot touch provider keys, prompts,
 * dangerous settings, or the custom provider).
 *
 * Synthetic data dir; the device registry is exercised end-to-end (mint →
 * exchange → bearer) exactly as a phone would.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";

// The data seam is read once, at first config import — fix it first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mobile-api-"));
process.env.LH_DATA_DIR = dataDir;

const { proxy } = await import("../proxy.ts");
const { corsHeadersFor, MOBILE_API_VERSION, MOBILE_SAFE_SETTINGS_SECTIONS } = await import("../src/server/mobile-api.ts");
const { mintPairing, exchangePairingCode } = await import("../src/store/devices.ts");
const bootstrapRoute = await import("../app/api/v1/bootstrap/route.ts");
const keysRoute = await import("../app/api/keys/route.ts");
const keyRoute = await import("../app/api/keys/[id]/route.ts");
const sectionRoute = await import("../app/api/settings/[section]/route.ts");
const promptRoute = await import("../app/api/settings/prompts/[...segment]/route.ts");
const customProviderRoute = await import("../app/api/custom-provider/route.ts");

function mobileToken(): string {
	const minted = mintPairing("mobile", "Test phone", "http://localhost:3000");
	const outcome = exchangePairingCode(minted.code);
	assert.ok(outcome.ok);
	return outcome.ok ? outcome.result.token : "";
}

function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
	return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

after(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the v1 bootstrap contract", () => {
	it("returns version, server mode, settings, chats and models in one response", async () => {
		const res = await bootstrapRoute.GET();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		const body = (await res.json()) as Record<string, unknown>;
		assert.equal(body.version, MOBILE_API_VERSION);
		assert.ok(body.server && typeof body.server === "object");
		assert.ok("mode" in (body.server as object), "server.mode present");
		assert.ok("settings" in body, "settings present (null on first boot is valid)");
		assert.ok(Array.isArray(body.chats), "chats is a list");
		assert.ok(body.models && typeof body.models === "object", "models catalog present");
		// The frozen-DTO law: every documented v1 key exists; adding is allowed.
		for (const key of ["version", "server", "settings", "chats", "models"]) assert.ok(key in body, key);
	});
});

describe("the CORS policy", () => {
	it("answers preflights only for declared origins and adds headers to gated responses", () => {
		process.env.LH_CORS_ORIGINS = "http://localhost:8081";
		try {
			assert.equal(corsHeadersFor("http://localhost:8081")?.["Access-Control-Allow-Origin"], "http://localhost:8081");
			assert.equal(corsHeadersFor("http://evil.test"), undefined);

			const preflight = proxy(new NextRequest("http://localhost:3000/api/v1/bootstrap", { method: "OPTIONS", headers: { origin: "http://localhost:8081" } }));
			assert.equal(preflight.status, 204);
			assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:8081");
			assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

			// Server mode ON, no credentials: the gate still answers 401 — and
			// the browser must be able to READ that error.
			process.env.LH_SERVER_PASSWORD = "pw";
			process.env.LH_SESSION_SECRET = "s".repeat(48);
			const gated = proxy(new NextRequest("http://localhost:3000/api/events", { headers: { origin: "http://localhost:8081" } }));
			assert.equal(gated.status, 401);
			assert.equal(gated.headers.get("access-control-allow-origin"), "http://localhost:8081");
		} finally {
			delete process.env.LH_CORS_ORIGINS;
			delete process.env.LH_SERVER_PASSWORD;
			delete process.env.LH_SESSION_SECRET;
		}
	});

	it("an undeclared origin gets no CORS headers at all", () => {
		process.env.LH_SERVER_PASSWORD = "pw";
		process.env.LH_SESSION_SECRET = "s".repeat(48);
		try {
			const res = proxy(new NextRequest("http://localhost:3000/api/events", { headers: { origin: "http://evil.test" } }));
			assert.equal(res.headers.get("access-control-allow-origin"), null);
		} finally {
			delete process.env.LH_SERVER_PASSWORD;
			delete process.env.LH_SESSION_SECRET;
		}
	});
});

describe("the mobile scope gates", () => {
	it("refuses provider keys, prompt overrides and dangerous settings; allows safe sections", async () => {
		const token = mobileToken();

		const keys = await keysRoute.GET(new Request("http://localhost/api/keys", { headers: bearer(token) }));
		assert.equal(keys.status, 403, "keys inventory is owner-only");
		const keyWrite = await keyRoute.PUT(new Request("http://localhost/api/keys/OPENAI_API_KEY", { method: "PUT", headers: bearer(token), body: JSON.stringify({ value: "x".repeat(24) }) }), { params: Promise.resolve({ id: "OPENAI_API_KEY" }) });
		assert.equal(keyWrite.status, 403, "key writes are owner-only");
		const keyDelete = await keyRoute.DELETE(new Request("http://localhost/api/keys/OPENAI_API_KEY", { method: "DELETE", headers: bearer(token) }), { params: Promise.resolve({ id: "OPENAI_API_KEY" }) });
		assert.equal(keyDelete.status, 403, "key deletes are owner-only");

		const dangerous = await sectionRoute.PUT(new Request("http://localhost/api/settings/models", { method: "PUT", headers: bearer(token), body: JSON.stringify({}) }), { params: Promise.resolve({ section: "models" }) });
		assert.equal(dangerous.status, 403, "model slots are owner-only");
		const agent = await sectionRoute.PUT(new Request("http://localhost/api/settings/agent", { method: "PUT", headers: bearer(token), body: JSON.stringify({}) }), { params: Promise.resolve({ section: "agent" }) });
		assert.equal(agent.status, 403, "tool authority is owner-only");

		assert.ok(MOBILE_SAFE_SETTINGS_SECTIONS.has("appearance"));
		const safe = await sectionRoute.PUT(new Request("http://localhost/api/settings/appearance", { method: "PUT", headers: bearer(token), body: JSON.stringify({}) }), { params: Promise.resolve({ section: "appearance" }) });
		assert.equal(safe.status, 200, "appearance is a safe section");

		const prompt = await promptRoute.PUT(new Request("http://localhost/api/settings/prompts/teacher/10-x.md", { method: "PUT", headers: bearer(token), body: JSON.stringify({ text: "hijack" }) }), { params: Promise.resolve({ segment: ["teacher", "10-x.md"] }) });
		assert.equal(prompt.status, 403, "system prompts are owner-only");

		const custom = await customProviderRoute.POST(new Request("http://localhost/api/custom-provider", { method: "POST", headers: bearer(token), body: JSON.stringify({}) }));
		assert.equal(custom.status, 403, "custom provider is owner-only");

		// Same actions with the server API token (an owner credential) pass the gate.
		process.env.LH_API_TOKEN = "a".repeat(32);
		try {
			const ownerKeys = await keysRoute.GET(new Request("http://localhost/api/keys", { headers: bearer("a".repeat(32)) }));
			assert.notEqual(ownerKeys.status, 403, "the owner token reads keys");
		} finally {
			delete process.env.LH_API_TOKEN;
		}
	});
});

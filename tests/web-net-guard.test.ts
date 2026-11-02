/**
 * Unit tests for the network guard (ssrf-guard wave, 2026-11-02):
 * src/agent/tools/net-guard.ts. The oracle (oracle/<id>/) covers the tool
 * level end-to-end; these pin the policy module's own edges.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertUrlPolicy,
	guardedFetch,
	isBlockedAddress,
	NET_GUARD_MAX_REDIRECTS,
} from "../src/agent/tools/net-guard.ts";

describe("the network guard", () => {
	it("blocks every private/reserved radius, allows public addresses", () => {
		const blocked = ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"];
		for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} blocked`);
		const allowed = ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"];
		for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, `${ip} allowed`);
	});

	it("policy: https-only, IP literals judged, private names refused, public names pass", () => {
		assert.equal(assertUrlPolicy("https://example.com/deep/page").hostname, "example.com");
		for (const url of [
			"http://example.com/",
			"https://127.0.0.1/x",
			"https://localhost/x",
			"https://sub.localhost/x",
			"https://10.0.0.1/x",
			"https://[::1]/x",
			"file:///etc/passwd",
			"not a url",
		]) {
			assert.throws(() => assertUrlPolicy(url), `${url} refused`);
		}
	});

	it("guardedFetch: blocked resolve never dials; redirect hops re-run the whole policy", async () => {
		let dials = 0;
		const transport = (async () => {
			dials += 1;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		await assert.rejects(
			guardedFetch("https://private.test/x", { lookup: async () => [{ address: "192.168.1.1", family: 4 }], transport }),
		);
		assert.equal(dials, 0, "a blocked resolve must not dial");

		const hops: string[] = [];
		let call = 0;
		const redirecting = (async (url: URL | string) => {
			dials += 1;
			hops.push(String(url));
			call += 1;
			return call <= 2
				? new Response(null, { status: 302, headers: { location: `https://next${call}.example/there` } })
				: new Response("arrived", { status: 200 });
		}) as unknown as typeof fetch;
		const res = await guardedFetch("https://start.example/", {
			lookup: async (h) => [{ address: "93.184.216.34", family: 4 }],
			transport: redirecting,
		});
		assert.equal(res.status, 200);
		assert.deepEqual(hops, ["https://start.example/", "https://next1.example/there", "https://next2.example/there"]);
	});

	it("guardedFetch stops at the redirect cap", async () => {
		let dials = 0;
		const transport = (async () => {
			dials += 1;
			return new Response(null, { status: 302, headers: { location: "https://loop.example/again" } });
		}) as unknown as typeof fetch;
		await assert.rejects(
			guardedFetch("https://start.example/", { lookup: async () => [{ address: "93.184.216.34", family: 4 }], transport }),
		);
		assert.equal(dials, NET_GUARD_MAX_REDIRECTS, "exactly the cap's worth of hops, then refusal");
	});
});

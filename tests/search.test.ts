/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, duckduckgoProvider } from "../src/server/search.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: the KEYLESS open default answers first (duckduckgo, owner 2026-11-05)", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(out.available);
		assert.equal(out.engine, "duckduckgo");
		assert.equal(out.key, null);
		assert.match(out.reason, /keyless open default/);
	});

	it("a key alone is enough — no engine choice needed (keyed ranks above DDG)", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});

	it("pinned duckduckgo is always live — keyless by design", () => {
		const out = resolveSearchEngineFor("duckduckgo", {});
		assert.ok(out.available);
		assert.equal(out.engine, "duckduckgo");
		assert.equal(out.key, null);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});
describe("duckduckgoProvider (the keyless open default, 2026-11-05)", () => {
	it("POSTs the html form and parses result__a + result__snippet", async () => {
		const html = [
			'<a class="result__a" href="https://en.wikipedia.org/wiki/Transformer_(deep_learning)">Transformer (deep learning) - Wikipedia</a>',
			'<a class="result__snippet" href="/x">In deep learning, the transformer is a family of models.</a>',
			'<a class="result__a" href="/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762&rut=x">Attention Is All You Need</a>',
			'<a class="result__snippet" href="/x">The original transformer paper.</a>',
		].join("\n");
		const calls: { url: string; body: string }[] = [];
		const provider = duckduckgoProvider(async (url, init) => {
			calls.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response(html, { status: 200 });
		});
		const hits = await provider.search("transformer attention", 5);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://html.duckduckgo.com/html/");
		assert.match(calls[0]!.body, /q=transformer\+attention/);
		assert.equal(hits.length, 2);
		assert.equal(hits[0]!.title, "Transformer (deep learning) - Wikipedia");
		assert.equal(hits[0]!.url, "https://en.wikipedia.org/wiki/Transformer_(deep_learning)");
		assert.match(hits[0]!.snippet, /family of models/);
		assert.equal(hits[1]!.url, "https://arxiv.org/abs/1706.03762", "the uddg redirect decodes");
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = duckduckgoProvider(async () => new Response("blocked", { status: 403 }));
		await assert.rejects(() => provider.search("q", 5), /DuckDuckGo search 403/);
	});
});

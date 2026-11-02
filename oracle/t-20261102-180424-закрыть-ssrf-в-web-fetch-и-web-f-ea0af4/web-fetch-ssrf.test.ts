/**
 * Oracle: SSRF-политика для web_fetch / web_fetch_pdf.
 *
 * Критерий (из постановки): research-job с web_fetch на loopback получает
 * отказ — включая редирект на loopback и адрес, резолвящийся в 127.0.0.1;
 * внешний https по-прежнему проходит политику.
 *
 * Тест намеренно не ходит в интернет: приватные кейсы проверяются против
 * локального http-сервера со счётчиком запросов, а позитивный путь и
 * редиректы — через инъецированные lookup/transport гарда.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWebTools } from "../../src/agent/tools/web.ts";
import { createPdfReadTools } from "../../src/agent/tools/pdf-read.ts";
import { guardedFetch, isBlockedAddress, assertUrlPolicy } from "../../src/agent/tools/net-guard.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

interface LocalServer {
	port: number;
	hits: () => number;
	close: () => Promise<void>;
}

async function startLocalServer(): Promise<LocalServer> {
	let hits = 0;
	const server = http.createServer((_req, res) => {
		hits += 1;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(`<html><head><title>local</title></head><body><article><p>${"secret ".repeat(80)}</p></article></body></html>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object", "local server must bind a TCP port");
	return {
		port: address.port,
		hits: () => hits,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

/** Tool result shape differs between the pi AgentTool contract and
 *  serverExecute's wrapper; accept both without guessing one of them. */
async function callTool(tool: any, args: Record<string, unknown>): Promise<string> {
	const text = (value: unknown): string => {
		if (typeof value === "string") return value;
		const content = (value as { content?: { text?: string }[] } | null)?.content;
		if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
		return JSON.stringify(value);
	};
	try {
		return text(await tool.execute("oracle-call", args, undefined, undefined, {}));
	} catch {
		return text(await tool.execute(args));
	}
}

function assertRefusal(out: string, label: string): void {
	assert.match(
		out,
		/block|refus|not allowed|private|loopback|link-local|only https/i,
		`${label}: expected a policy refusal string, got: ${out.slice(0, 200)}`,
	);
}

// ── address policy ──────────────────────────────────────────────────────────

test("isBlockedAddress blocks loopback, private, link-local, CGNAT, ULA and mapped forms", () => {
	const blocked = [
		"127.0.0.1",
		"127.1.2.3",
		"0.0.0.0",
		"10.0.0.5",
		"172.16.4.4",
		"172.31.255.254",
		"192.168.1.1",
		"100.64.0.1",
		"169.254.169.254",
		"192.0.2.10",
		"198.18.0.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"fd12:3456::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
	];
	for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);

	const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"];
	for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
});

test("assertUrlPolicy allows only external https", () => {
	assert.equal(assertUrlPolicy("https://example.com/page").hostname, "example.com");
	for (const url of [
		"http://example.com/page",
		"https://127.0.0.1:3000/api/chats",
		"https://localhost:3000/api/chats",
		"https://localhost.:3000/api/chats",
		"https://foo.localhost/x",
		"https://10.0.0.5/x",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]:3000/x",
		"https://[fe80::1]/x",
		"file:///etc/passwd",
		"ftp://example.com/x",
	]) {
		assert.throws(() => assertUrlPolicy(url), undefined, `${url} must be rejected by policy`);
	}
});

// ── tools: literal loopback and loopback-resolving hostname ─────────────────

test("web_fetch refuses literal loopback and never opens a connection", async () => {
	const server = await startLocalServer();
	try {
		const tools = createWebTools(() => null);
		for (const url of [
			`http://127.0.0.1:${server.port}/api/chats`,
			`https://127.0.0.1:${server.port}/api/chats`,
		]) {
			const out = await callTool(tools.web_fetch, { url });
			assertRefusal(out, `web_fetch ${url}`);
		}
		assert.equal(server.hits(), 0, "no request may reach the loopback server");
	} finally {
		await server.close();
	}
});

test("web_fetch refuses a hostname that resolves to loopback", async () => {
	const server = await startLocalServer();
	try {
		const tools = createWebTools(() => null);
		const out = await callTool(tools.web_fetch, { url: `https://localhost:${server.port}/api/chats` });
		assertRefusal(out, "web_fetch https://localhost");
		assert.equal(server.hits(), 0, "DNS resolution to 127.0.0.1 must be blocked before connecting");
	} finally {
		await server.close();
	}
});

test("web_fetch_pdf refuses loopback and writes no file", async () => {
	const server = await startLocalServer();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-oracle-pdf-"));
	try {
		const tools = createPdfReadTools(dir);
		for (const url of [`https://127.0.0.1:${server.port}/paper.pdf`, `http://localhost:${server.port}/paper.pdf`]) {
			const out = await callTool(tools.web_fetch_pdf, { url });
			assertRefusal(out, `web_fetch_pdf ${url}`);
		}
		assert.equal(server.hits(), 0, "no request may reach the loopback server");
		assert.deepEqual(await fs.readdir(dir), [], "no PDF file may be written for a blocked URL");
	} finally {
		await server.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── guard: DNS pinning, redirects, positive path ────────────────────────────

test("guardedFetch rejects a DNS name resolving to 127.0.0.1 before transport", async () => {
	let transportCalls = 0;
	const transport = (async () => {
		transportCalls += 1;
		return new Response("should never be used", { status: 200 });
	}) as unknown as typeof fetch;
	await assert.rejects(
		guardedFetch("https://internal.test/api/chats", {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			transport,
		}),
	);
	assert.equal(transportCalls, 0, "a blocked address must not reach the transport");
});

test("guardedFetch blocks a redirect hop to loopback and stops following", async () => {
	let transportCalls = 0;
	const transport = (async () => {
		transportCalls += 1;
		return new Response(null, { status: 302, headers: { location: "https://127.0.0.1:3000/api/chats" } });
	}) as unknown as typeof fetch;
	await assert.rejects(
		guardedFetch("https://public.example/start", {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			transport,
		}),
	);
	assert.equal(transportCalls, 1, "the loopback hop must not be dialled");
});

test("guardedFetch blocks a redirect hop whose hostname resolves to a private address", async () => {
	let transportCalls = 0;
	const transport = (async () => {
		transportCalls += 1;
		return new Response(null, { status: 301, headers: { location: "https://intranet.example/x" } });
	}) as unknown as typeof fetch;
	await assert.rejects(
		guardedFetch("https://public.example/start", {
			lookup: async (hostname: string) =>
				hostname === "public.example"
					? [{ address: "93.184.216.34", family: 4 }]
					: [{ address: "10.0.0.5", family: 4 }],
			transport,
		}),
	);
	assert.equal(transportCalls, 1);
});

test("guardedFetch allows an external https page (policy positive path)", async () => {
	let transportCalls = 0;
	const transport = (async () => {
		transportCalls += 1;
		return new Response("<html><body>ok</body></html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		});
	}) as unknown as typeof fetch;
	const res = await guardedFetch("https://example.com/page", {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		transport,
	});
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "<html><body>ok</body></html>");
	assert.equal(transportCalls, 1);
});

test("guardedFetch stops after the redirect limit instead of looping forever", async () => {
	let transportCalls = 0;
	const transport = (async () => {
		transportCalls += 1;
		return new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
	}) as unknown as typeof fetch;
	await assert.rejects(
		guardedFetch("https://example.com/loop", {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			transport,
		}),
	);
	assert.ok(transportCalls <= 10, `redirect following must be bounded, saw ${transportCalls} calls`);
});

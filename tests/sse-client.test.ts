/**
 * Tests for the mobile SSE client (rn-sse wave, 2026-11-02): the wire
 * parser, the reconnecting client (Last-Event-ID, 401 stop, abort) and the
 * XHR transport React Native uses. No network: transports are scripted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createSseClient,
	createSseParser,
	xhrSseTransport,
	type SseEvent,
} from "../src/core/sse.ts";

const encoder = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

/** Wait until `done()` — the scripted transports settle in microtasks and
 *  short retry timers; a generous cap keeps CI sane. */
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!done()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition never became true");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

describe("the SSE wire parser", () => {
	it("parses fields, joins multi-line data, ignores comments and unknown fields", () => {
		const parser = createSseParser();
		const events = parser.feed(
			": keep-alive\n" +
			"event: turn\n" +
			"id: 7\n" +
			"data: first line\n" +
			"data: second line\n" +
			"unknown: ignored\n" +
			"\n" +
			"data: next\r\n\r\n",
		);
		assert.equal(events.length, 2);
		assert.deepEqual(events[0], { event: "turn", data: "first line\nsecond line", id: "7" });
		assert.deepEqual(events[1], { event: "message", data: "next", id: "7" });
		assert.equal(parser.lastEventId, "7");
	});

	it("splits chunks mid-line and honors retry fields", () => {
		const parser = createSseParser();
		assert.deepEqual(parser.feed("id: a\ndata: par"), []);
		assert.deepEqual(parser.feed("tial\n\n"), [{ event: "message", data: "partial", id: "a" }]);
		const withRetry = createSseParser();
		assert.deepEqual(withRetry.feed("retry: 2500\ndata: x\n\n"), [{ event: "message", data: "x", id: undefined, retry: 2500 }]);
	});

	it("an unfinished event still dispatches at EOF", () => {
		const parser = createSseParser();
		parser.feed("data: tail");
		assert.deepEqual(parser.end(), [{ event: "message", data: "tail", id: undefined }]);
	});
});

describe("the reconnecting client", () => {
	it("reconnects after a drop and resumes with Last-Event-ID", async () => {
		const calls: Record<string, string>[] = [];
		const transport = async (request: { headers: Record<string, string> }) => {
			calls.push({ ...request.headers });
			if (calls.length === 1) {
				return {
					status: 200,
					body: streamOf([
						'id: 1\ndata: {"type":"one"}\n\n',
						'id: 2\ndata: {"type":"two"}\n\n',
					]),
				};
			}
			return { status: 200, body: streamOf(['id: 3\ndata: {"type":"three"}\n\n']) };
		};
		const events: SseEvent[] = [];
		let client: ReturnType<typeof createSseClient>;
		client = createSseClient({
			url: "https://server.test/api/chats/c1/stream",
			headers: { authorization: "Bearer t" },
			transport,
			retryMs: 1,
			maxRetries: 3,
			// Close on the third event: the scripted transport is finite, and a
			// closed stream legitimately reconnects — the test pins the resume,
			// not an endless loop against the same fake.
			onEvent: (event) => {
				events.push(event);
				if (event.id === "3") client.close();
			},
		});
		await until(() => events.length >= 3);

		assert.deepEqual(events.map((event) => event.id), ["1", "2", "3"]);
		assert.equal(events[2]!.data, '{"type":"three"}');
		assert.equal(calls.length, 2, "one drop, one reconnect");
		assert.equal(calls[0]!["last-event-id"], undefined, "the first connect carries no last-event-id");
		assert.equal(calls[1]!["last-event-id"], "2", "the reconnect resumes from the last id");
		assert.equal(calls[1]!.authorization, "Bearer t", "auth headers survive the reconnect");
		assert.equal(client.lastEventId, "3");
	});

	it("401 stops the client instead of spinning (revoked device)", async () => {
		let calls = 0;
		const client = createSseClient({
			url: "https://server.test/api/events",
			transport: async () => {
				calls += 1;
				return { status: 401, body: null };
			},
			retryMs: 1,
			onEvent: () => assert.fail("no events"),
			onError: () => undefined,
		});
		await until(() => client.state === "closed");
		assert.equal(calls, 1, "no retry after 401");
	});

	it("close() during backoff stops the loop", async () => {
		let calls = 0;
		const client = createSseClient({
			url: "https://server.test/api/events",
			transport: async () => {
				calls += 1;
				return { status: 500, body: null };
			},
			retryMs: 200,
			onEvent: () => undefined,
			onError: () => undefined,
		});
		await until(() => calls === 1);
		client.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(client.state, "closed");
		assert.equal(calls, 1, "no further attempts after close");
	});
});

describe("the XHR transport (React Native)", () => {
	it("streams progress chunks and parses them through the client", async () => {
		class FakeXhr {
			static instances: FakeXhr[] = [];
			readyState = 0;
			status = 0;
			responseText = "";
			headers: Record<string, string> = {};
			onreadystatechange?: () => void;
			onprogress?: () => void;
			onload?: () => void;
			onerror?: () => void;
			open() {
				/* readyState transitions are driven by the test */
			}
			setRequestHeader(name: string, value: string) {
				this.headers[name] = value;
			}
			send() {
				FakeXhr.instances.push(this);
			}
			abort() {
				/* the fake never streams after abort */
			}
		}
		const transport = xhrSseTransport(FakeXhr as unknown as typeof XMLHttpRequest);
		const events: SseEvent[] = [];
		const client = createSseClient({
			url: "https://server.test/api/events",
			headers: { authorization: "Bearer xhr" },
			transport,
			retryMs: 1,
			maxRetries: 0,
			onEvent: (event) => events.push(event),
		});
		await until(() => FakeXhr.instances.length === 1);
		const xhr = FakeXhr.instances[0]!;
		xhr.readyState = 2;
		xhr.status = 200;
		xhr.onreadystatechange?.();
		xhr.responseText = 'data: {"type":"first"}\n\n';
		xhr.onprogress?.();
		xhr.responseText += 'data: {"type":"second"}\n\n';
		xhr.onprogress?.();
		xhr.onload?.();
		await until(() => events.length >= 2);
		client.close();
		assert.deepEqual(events.map((event) => event.data), ['{"type":"first"}', '{"type":"second"}']);
		assert.equal(xhr.headers.accept, "text/event-stream");
		assert.equal(xhr.headers.authorization, "Bearer xhr");
	});
});

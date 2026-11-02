/**
 * THE SSE CLIENT FOR MOBILE (rn-sse wave, 2026-11-02): the server's
 * existing SSE contract, readable from a phone. Native React Native fetch
 * cannot stream response bodies, and EventSource does not exist there —
 * so the transport is injected: the default rides fetch's ReadableStream
 * (web/dev, Node), `xhrSseTransport` rides XMLHttpRequest progress events
 * (React Native), and tests script their own.
 *
 * The wire parser is the WHATWG SSE grammar subset the server uses plus
 * the parts a reconnecting client needs: `data`/`event`/`id`/`retry`
 * fields, comment lines, CRLF/LF, multi-line data joined with "\n",
 * dispatch on a blank line. Reconnect is built in: after a drop the
 * client re-opens the same URL with `Last-Event-ID`, so a server that
 * supports resumption continues where the stream stopped; the current
 * server's replay-from-start remains correct too — the caller receives
 * the log again and settles view state by event content (the existing
 * wire contract: full-state events, never deltas).
 *
 * 401/403 stop the client (a revoked device must not spin); other
 * failures back off exponentially and retry. Abort is cooperative via
 * AbortSignal or close().
 */

export interface SseEvent {
	/** "message" when the wire carried no event name. */
	event: string;
	data: string;
	/** The last id seen on the wire AT dispatch time (WHATWG semantics). */
	id: string | undefined;
	/** A server-suggested reconnect delay, when present. */
	retry?: number;
}

// ── the wire parser ─────────────────────────────────────────────────────────

export interface SseParser {
	/** Feed decoded text; returns the events completed by this chunk. */
	feed(chunk: string): SseEvent[];
	/** Flush EOF: a trailing complete event still dispatches (WHATWG). */
	end(): SseEvent[];
	readonly lastEventId: string | undefined;
}

export function createSseParser(): SseParser {
	let buffer = "";
	let dataLines: string[] = [];
	let eventName = "";
	let lastId: string | undefined;
	let pendingRetry: number | undefined;
	const done: SseEvent[] = [];

	const dispatch = () => {
		if (dataLines.length === 0) {
			eventName = "";
			pendingRetry = undefined;
			return;
		}
		done.push({
			event: eventName || "message",
			data: dataLines.join("\n"),
			id: lastId,
			...(pendingRetry !== undefined ? { retry: pendingRetry } : {}),
		});
		dataLines = [];
		eventName = "";
		pendingRetry = undefined;
	};

	const processLine = (rawLine: string) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return; // comment / keep-alive
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (field) {
			case "data":
				dataLines.push(value);
				break;
			case "event":
				eventName = value;
				break;
			case "id":
				if (!value.includes("\0")) lastId = value;
				break;
			case "retry":
				if (/^\d+$/.test(value)) pendingRetry = Number(value);
				break;
			default:
				break; // unknown fields are ignored (WHATWG)
		}
	};

	return {
		feed(chunk: string): SseEvent[] {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				processLine(line);
			}
			return done.splice(0);
		},
		end(): SseEvent[] {
			if (buffer.length > 0) {
				processLine(buffer);
				buffer = "";
			}
			dispatch();
			return done.splice(0);
		},
		get lastEventId() {
			return lastId;
		},
	};
}

// ── transports ──────────────────────────────────────────────────────────────

export interface SseTransportRequest {
	url: string;
	headers: Record<string, string>;
	signal?: AbortSignal;
}

export interface SseTransportResponse {
	status: number;
	body: ReadableStream<Uint8Array> | null;
}

export type SseTransport = (request: SseTransportRequest) => Promise<SseTransportResponse>;

/** The default: fetch + ReadableStream. Web and Node; React Native's fetch
 *  leaves `body` null — use xhrSseTransport there. */
export const fetchSseTransport: SseTransport = async ({ url, headers, signal }) => {
	const response = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal, cache: "no-store" });
	return { status: response.status, body: response.body };
};

/** React Native's streaming seam: XMLHttpRequest progress events parsed
 *  incrementally into a ReadableStream. The XHR class is injectable for
 *  tests. Resolves once response headers arrive (readyState 2), rejects on
 *  network error/timeout. */
export function xhrSseTransport(
	XmlHttpRequestCtor: typeof XMLHttpRequest = globalThis.XMLHttpRequest,
): SseTransport {
	return ({ url, headers, signal }) =>
		new Promise<SseTransportResponse>((resolve, reject) => {
			const xhr = new XmlHttpRequestCtor();
			let seen = 0;
			let settled = false;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const pushDelta = () => {
						const text = xhr.responseText ?? "";
						if (text.length <= seen) return;
						const chunk = text.slice(seen);
						seen = text.length;
						controller.enqueue(new TextEncoder().encode(chunk));
					};
					xhr.onreadystatechange = () => {
						if (settled || xhr.readyState < 2) return;
						settled = true;
						pushDelta();
						if (xhr.status === 0) {
							controller.error(new Error("xhr sse network error"));
							reject(new Error("xhr sse network error"));
							return;
						}
						resolve({ status: xhr.status, body: stream });
					};
					xhr.onprogress = () => pushDelta();
					xhr.onload = () => {
						if (!settled) {
							settled = true;
							resolve({ status: xhr.status, body: stream });
						}
						pushDelta();
						try {
							controller.close();
						} catch {
							/* already errored */
						}
					};
					xhr.onerror = () => {
						if (!settled) {
							settled = true;
							reject(new Error("xhr sse network error"));
						}
						try {
							controller.error(new Error("xhr sse network error"));
						} catch {
							/* already closed */
						}
					};
					signal?.addEventListener("abort", () => xhr.abort(), { once: true });
					xhr.open("GET", url);
					xhr.setRequestHeader("accept", "text/event-stream");
					for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
					xhr.send();
				},
				cancel() {
					xhr.abort();
				},
			});
		});
}

// ── the reconnecting client ────────────────────────────────────────────────

export type SseConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface SseClientOptions {
	url: string;
	/** Extra request headers (authorization, etc.). */
	headers?: Record<string, string>;
	transport?: SseTransport;
	onEvent: (event: SseEvent) => void;
	onState?: (state: SseConnectionState) => void;
	onError?: (error: unknown) => void;
	/** Base reconnect delay; doubles per consecutive failure. */
	retryMs?: number;
	maxRetryMs?: number;
	/** Consecutive-failure cap before giving up (default: retry forever). */
	maxRetries?: number;
	signal?: AbortSignal;
}

export interface SseClient {
	close(): void;
	readonly lastEventId: string | undefined;
	readonly state: SseConnectionState;
}

export function createSseClient(options: SseClientOptions): SseClient {
	const transport = options.transport ?? fetchSseTransport;
	let state: SseConnectionState = "connecting";
	let closed = false;
	let lastEventId: string | undefined;
	let controller: AbortController | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	const setState = (next: SseConnectionState) => {
		state = next;
		options.onState?.(next);
	};

	const stop = () => {
		if (closed) return;
		closed = true;
		if (retryTimer) clearTimeout(retryTimer);
		controller?.abort();
		setState("closed");
	};
	options.signal?.addEventListener("abort", stop, { once: true });

	void (async () => {
		let failures = 0;
		setState("connecting");
		while (!closed) {
			controller = new AbortController();
			try {
				const headers: Record<string, string> = { ...(options.headers ?? {}) };
				if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
				const response = await transport({ url: options.url, headers, signal: controller.signal });
				if (response.status === 401 || response.status === 403) {
					// An unauthorized client must not spin (revoked device, signed-out).
					options.onError?.(new Error(`sse refused with HTTP ${response.status}`));
					stop();
					return;
				}
				if (response.status !== 200) throw new Error(`sse answered HTTP ${response.status}`);
				if (!response.body) {
					throw new Error("the transport cannot stream response bodies — use xhrSseTransport on React Native");
				}
				failures = 0;
				setState("open");
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				const parser = createSseParser();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
						if (event.id !== undefined) lastEventId = event.id;
						options.onEvent(event);
						if (closed) return;
					}
				}
				for (const event of parser.end()) {
					if (event.id !== undefined) lastEventId = event.id;
					options.onEvent(event);
					if (closed) return;
				}
			} catch (error) {
				if (closed) return;
				options.onError?.(error);
			}
			if (closed) return;
			failures += 1;
			if (options.maxRetries !== undefined && failures > options.maxRetries) {
				stop();
				return;
			}
			setState("reconnecting");
			const base = options.retryMs ?? 1000;
			const cap = options.maxRetryMs ?? 15_000;
			const delay = Math.min(cap, base * 2 ** Math.min(failures - 1, 5));
			await new Promise<void>((resolve) => {
				retryTimer = setTimeout(resolve, delay);
			});
		}
	})();

	return {
		close: stop,
		get lastEventId() {
			return lastEventId;
		},
		get state() {
			return state;
		},
	};
}

/**
 * THE MOBILE SSE CLIENT (mobile wave, 2026-11-04): adapted from the
 * desktop's src/core/sse.ts (rn-sse wave) — the parser and reconnecting
 * client are unchanged; only the chunk decoding differs: React Native's
 * Hermes lacks TextDecoder, so UTF-8 chunks decode through a small
 * incremental decoder here.
 */

export interface SseEvent {
	event: string;
	data: string;
	id: string | undefined;
	retry?: number;
}

export interface SseParser {
	feed(bytes: Uint8Array): SseEvent[];
	end(): SseEvent[];
	readonly lastEventId: string | undefined;
}

/** Incremental UTF-8 decoder (Hermes-safe): carries multi-byte sequences
 *  across chunk boundaries, replaces malformed bytes with U+FFFD. */
function createUtf8Decoder() {
	let pending: number[] = [];
	return {
		decode(bytes: Uint8Array, final = false): string {
			const all = pending.length > 0 ? [...pending, ...bytes] : [...bytes];
			pending = [];
			let out = "";
			let i = 0;
			while (i < all.length) {
				const b0 = all[i]!;
				let need = 0;
				let code = 0;
				if (b0 < 0x80) {
					out += String.fromCharCode(b0);
					i += 1;
					continue;
				} else if ((b0 & 0xe0) === 0xc0) {
					need = 1;
					code = b0 & 0x1f;
				} else if ((b0 & 0xf0) === 0xe0) {
					need = 2;
					code = b0 & 0x0f;
				} else if ((b0 & 0xf8) === 0xf0) {
					need = 3;
					code = b0 & 0x07;
				} else {
					out += "\ufffd";
					i += 1;
					continue;
				}
				if (i + need >= all.length) {
					if (!final) pending = all.slice(i);
					break;
				}
				let ok = true;
				for (let k = 1; k <= need; k++) {
					const b = all[i + k]!;
					if ((b & 0xc0) !== 0x80) {
						ok = false;
						break;
					}
					code = (code << 6) | (b & 0x3f);
				}
				if (!ok) {
					out += "\ufffd";
					i += 1;
					continue;
				}
				if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) out += "\ufffd";
				else if (code > 0xffff) {
					code -= 0x10000;
					out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
				} else out += String.fromCharCode(code);
				i += need + 1;
			}
			return out;
		},
	};
}

/** UTF-8 encoder (Hermes-safe: TextEncoder is not guaranteed in RN). */
function encodeUtf8(text: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const low = text.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				i += 1;
			}
		}
		if (code < 0x80) bytes.push(code);
		else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
	}
	return new Uint8Array(bytes);
}

export function createSseParser(): SseParser {
	const decode = createUtf8Decoder();
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
		if (line.startsWith(":")) return;
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
				break;
		}
	};

	return {
		feed(bytes: Uint8Array): SseEvent[] {
			buffer += decode.decode(bytes, false);
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
				buffer += decode.decode(new Uint8Array(), true);
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

export type SseConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface SseClient {
	close(): void;
	readonly lastEventId: string | undefined;
	readonly state: SseConnectionState;
}

export interface SseClientOptions {
	url: string;
	headers?: Record<string, string>;
	onEvent: (event: SseEvent) => void;
	onState?: (state: SseConnectionState) => void;
	onError?: (error: unknown) => void;
	retryMs?: number;
	maxRetryMs?: number;
	maxRetries?: number;
}

/** React Native's XMLHttpRequest streams progress deltas; fetch does not
 *  stream on RN — this transport is the one the app uses. */
export function createXhrSseClient(options: SseClientOptions): SseClient {
	let state: SseConnectionState = "connecting";
	let closed = false;
	let lastEventId: string | undefined;
	let xhr: XMLHttpRequest | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	const setState = (next: SseConnectionState) => {
		state = next;
		options.onState?.(next);
	};
	const stop = () => {
		if (closed) return;
		closed = true;
		if (retryTimer) clearTimeout(retryTimer);
		try {
			xhr?.abort();
		} catch {
			/* already done */
		}
		setState("closed");
	};

	void (async () => {
		let failures = 0;
		setState("connecting");
		while (!closed) {
			try {
				await new Promise<void>((resolveRequest, rejectRequest) => {
					const request = new XMLHttpRequest();
					xhr = request;
					let seen = 0;
					const parser = createSseParser();
					let settled = false;
					request.onreadystatechange = () => {
						if (settled || request.readyState < 2) return;
						settled = true;
						if (request.status === 401 || request.status === 403) {
							options.onError?.(new Error(`sse refused with HTTP ${request.status}`));
							stop();
							rejectRequest(new Error("unauthorized"));
							return;
						}
						if (request.status !== 200) {
							rejectRequest(new Error(`sse answered HTTP ${request.status}`));
							return;
						}
						settled = false; // headers only — body follows
						failures = 0;
						setState("open");
					};
					request.onprogress = () => {
						const text = request.responseText ?? "";
						if (text.length <= seen) return;
						const chunk = text.slice(seen);
						seen = text.length;
						for (const event of parser.feed(encodeUtf8(chunk))) {
							if (event.id !== undefined) lastEventId = event.id;
							options.onEvent(event);
							if (closed) return;
						}
					};
					request.onload = () => {
						const text = request.responseText ?? "";
						if (text.length > seen) {
							for (const event of parser.feed(encodeUtf8(text.slice(seen)))) {
								if (event.id !== undefined) lastEventId = event.id;
								options.onEvent(event);
							}
						}
						try {
							request.abort();
						} catch {
							/* done */
						}
						if (!closed) rejectRequest(new Error("stream ended"));
					};
					request.onerror = () => rejectRequest(new Error("sse network error"));
					request.ontimeout = () => rejectRequest(new Error("sse timeout"));
					request.open("GET", options.url);
					request.setRequestHeader("accept", "text/event-stream");
					const headers = { ...(options.headers ?? {}) };
					if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
					for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
					request.send();
				});
			} catch (error) {
				if (closed) return;
				if (error instanceof Error && error.message === "unauthorized") return;
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
			const delay = Math.min(options.maxRetryMs ?? 15_000, base * 2 ** Math.min(failures - 1, 5));
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

/**
 * THE MOBILE API CLIENT (mobile wave, 2026-11-04): thin fetch wrappers
 * over the frozen v1 contract — bearer device-token auth, JSON errors as
 * Error messages the screens show verbatim.
 */

export interface BootstrapChat {
	id: string;
	title: string;
	kind: "teach" | "practice" | string;
	updatedAt: string;
	messageCount: number;
	phase?: string;
	pendingQuestion: boolean;
	busy: boolean;
	compacting: boolean;
}

export interface BootstrapResponse {
	version: string;
	server: { mode: string; apiVersion: string };
	settings: Record<string, unknown> | null;
	chats: BootstrapChat[];
	models: unknown;
}

export interface PendingQuestion {
	toolCallId: string;
	tool: string;
	kind: "quiz" | "ask" | "explain" | string;
	questionType?: string;
	question: string;
	context?: string;
	mode: "single-select" | "multi-select" | "text" | string;
	options?: { label: string; value: string }[];
}

export interface ChatView {
	chat: { id: string; title: string; kind: string; updatedAt: string };
	busy: boolean;
	compacting: boolean;
	turnFailure?: string;
	messages: { id: string; role: "user" | "assistant" | "divider"; text: string }[];
	pendingQuestions: PendingQuestion[];
}

export interface PairResult {
	token: string;
	deviceId: string;
	name: string;
	scope: string;
	expiresAt?: string;
}

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class Api {
	constructor(
		readonly baseUrl: string,
		readonly token: string,
	) {}

	private async request(path: string, init?: RequestInit): Promise<Response> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
				accept: "application/json",
				...(init?.headers ?? {}),
			},
		});
		return response;
	}

	private async json<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.request(path, init);
		if (!response.ok) {
			let message = `HTTP ${response.status}`;
			try {
				const body = (await response.json()) as { error?: string };
				if (body?.error) message = body.error;
			} catch {
				/* non-json error body */
			}
			throw new ApiError(response.status, message);
		}
		return (await response.json()) as T;
	}

	bootstrap(): Promise<BootstrapResponse> {
		return this.json<BootstrapResponse>("/api/v1/bootstrap");
	}

	chatView(chatId: string): Promise<ChatView> {
		return this.json<ChatView>(`/api/chats/${encodeURIComponent(chatId)}/view`);
	}

	/** POST /api/chat — one input event. Returns the HTTP status: 202-ish
	 *  acceptance, 409 turn-in-flight, 503 models-not-configured. */
	async sendInput(chatId: string, input: Record<string, unknown>): Promise<number> {
		const response = await this.request("/api/chat", {
			method: "POST",
			body: JSON.stringify({ chatId, input }),
		});
		return response.status;
	}

	async abortTurn(chatId: string): Promise<boolean> {
		const response = await this.request("/api/activity/abort", {
			method: "POST",
			body: JSON.stringify({ kind: "turn", id: chatId }),
		});
		return response.ok;
	}

	async createSession(title: string): Promise<{ id: string; title: string }> {
		return this.json<{ id: string; title: string }>("/api/chats", {
			method: "POST",
			body: JSON.stringify({ title }),
		});
	}

	/** The pairing exchange (public by design — the one-time code is the
	 *  credential). `code` case-insensitive; burned on any attempt. */
	static async pair(serverUrl: string, code: string): Promise<PairResult> {
		const response = await fetch(`${serverUrl}/api/devices/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: code.trim().toUpperCase() }),
		});
		if (!response.ok) {
			let message = `HTTP ${response.status}`;
			try {
				const body = (await response.json()) as { error?: string };
				if (body?.error) message = body.error;
			} catch {
				/* non-json */
			}
			throw new ApiError(response.status, message);
		}
		return (await response.json()) as PairResult;
	}
}

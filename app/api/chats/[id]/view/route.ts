import { compactionInFlight, isTurnRunning, stores } from "@/src/server";
import { turnFailure } from "@/src/server/turn-runs.ts";
import { questionCallsOf } from "@/src/core/native-messages.ts";
import { parseQuestionInput } from "@/src/core/tool-parts.ts";
import type { LhMessage } from "@/src/core/native-messages.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/chats/:id/view — THE MOBILE TRANSCRIPT CONTRACT (mobile-client
 * wave, 2026-11-04): the chat projected for a phone — plain-text messages,
 * the parsed pending question(s), and the live flags — so the client never
 * re-implements the dock's tool-call parsing. Frozen v1: additive only.
 *
 *   { chat: {id, title, kind, updatedAt},
 *     busy, compacting, turnFailure?,
 *     messages: [{id, role: "user"|"assistant"|"divider", text}],
 *     pendingQuestions: [{ toolCallId, tool, kind, questionType?, question,
 *                          context?, mode, options?: [{label, value}] }] }
 *
 * v1 scope: text + question cards. Tool activities, demos and the graph
 * render on the desktop; the phone shows the lesson's words and asks its
 * learner to answer where it matters.
 */

function textOf(message: LhMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => {
			const typed = part as { type?: string; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const messages: { id: string; role: "user" | "assistant" | "divider"; text: string }[] = [];
	for (const message of record.messages) {
		if (message.role === "user") {
			const text = textOf(message);
			if (text) messages.push({ id: message.id, role: "user", text });
			continue;
		}
		if (message.role === "assistant") {
			const text = textOf(message);
			if (text) messages.push({ id: message.id, role: "assistant", text });
			continue;
		}
		const custom = message as { role: string; customType?: string; content?: unknown };
		if (custom.role === "custom" && custom.customType === "compaction") {
			const text = textOf(message);
			messages.push({ id: message.id, role: "divider", text: text || "Сжатый контекст" });
		}
	}

	// The pending question(s): every answerable call, parsed by the same
	// display parser the desktop dock uses. The parser returns the posed
	// question directly (one question per call; parallel batches are
	// separate calls).
	const pendingQuestions = questionCallsOf(record.messages)
		.filter((call) => call.status === "answerable")
		.map((call) => {
			const parsed = parseQuestionInput(call.tool, call.input);
			if (!parsed) return null;
			const options = ("options" in parsed ? parsed.options : undefined)?.map((option: { label: string; value?: string }) => ({
				label: option.label,
				value: option.value ?? option.label,
			}));
			const kind =
				call.tool === "explain" || call.tool === "recall"
					? "explain"
					: call.tool === "ask_user_question"
						? "ask"
						: "quiz";
			const mode = "multiSelect" in parsed && parsed.multiSelect
				? "multi-select"
				: (options?.length ?? 0) > 0
					? "single-select"
					: "text";
			return {
				toolCallId: call.toolCallId,
				tool: call.tool,
				kind,
				questionType: "type" in parsed ? (parsed as { type?: "predict" | "check" }).type : undefined,
				question: parsed.question,
				context: "details" in parsed ? (parsed as { details?: string }).details : undefined,
				mode,
				...((options?.length ?? 0) > 0 ? { options } : {}),
			};
		})
		.filter((card): card is NonNullable<typeof card> => card !== null);

	return Response.json(
		{
			chat: { id: record.id, title: record.title, kind: record.kind, updatedAt: record.updatedAt },
			busy: isTurnRunning(id),
			compacting: compactionInFlight(id),
			turnFailure: turnFailure(id),
			messages,
			pendingQuestions,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}

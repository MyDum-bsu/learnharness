import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	BackHandler,
	FlatList,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Api, type ChatView, type PendingQuestion } from "../lib/api";
import { createXhrSseClient, type SseClient } from "../lib/sse";
import { colors, spacing } from "../theme";

/**
 * THE LESSON SCREEN (mobile wave, 2026-11-04): the transcript from
 * /api/chats/:id/view, live through the SSE stream (full-state events →
 * throttled refetch), the pending question(s) as answer cards, the
 * composer, and abort/retry/continue.
 */

interface Entry {
	key: string;
	kind: "user" | "assistant" | "divider";
	text: string;
}

export function ChatScreen({ api, chatId, title, onBack }: { api: Api; chatId: string; title: string; onBack: () => void }) {
	const [view, setView] = useState<ChatView | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const streamRef = useRef<SseClient | undefined>(undefined);
	const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const selectedByCall = useRef<Record<string, string[]>>({});
	const thinkingByCall = useRef<Record<string, string>>({});
	const dontKnowByCall = useRef<Record<string, boolean>>({});
	const [, forceRender] = useState(0);

	const scheduleRefetch = useCallback(() => {
		if (refetchTimer.current) return;
		refetchTimer.current = setTimeout(() => {
			refetchTimer.current = undefined;
			void load();
		}, 250);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const load = useCallback(async () => {
		try {
			const next = await api.chatView(chatId);
			setView(next);
			setLoadError(undefined);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "не удалось загрузить");
		}
	}, [api, chatId]);

	useEffect(() => {
		void load();
		const stream = createXhrSseClient({
			url: `${api.baseUrl}/api/chats/${encodeURIComponent(chatId)}/stream`,
			headers: { authorization: `Bearer ${api.token}` },
			retryMs: 2000,
			onEvent: () => scheduleRefetch(),
			onError: () => undefined,
		});
		streamRef.current = stream;
		const back = BackHandler.addEventListener("hardwareBackPress", () => {
			onBack();
			return true;
		});
		return () => {
			back.remove();
			stream.close();
			if (refetchTimer.current) clearTimeout(refetchTimer.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [api, chatId]);

	const send = async (input: Record<string, unknown>, optimisticText?: string) => {
		if (sending) return;
		setSending(true);
		if (optimisticText) {
			setView((current) =>
				current
					? { ...current, messages: [...current.messages, { id: `local-${Date.now()}`, role: "user", text: optimisticText }] }
					: current,
			);
		}
		try {
			const status = await api.sendInput(chatId, input);
			if (status === 409) setLoadError("Ход уже выполняется — секунду");
			else if (status !== 200) setLoadError(`Сервер ответил ${status}`);
			else setLoadError(undefined);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "не удалось отправить");
		} finally {
			setSending(false);
			void load();
		}
	};

	const answerQuestion = async (card: PendingQuestion, dontKnow: boolean) => {
		const selected = selectedByCall.current[card.toolCallId] ?? [];
		if (!dontKnow && selected.length === 0 && card.mode !== "text" && card.mode !== "multi-select") return;
		const thinking = thinkingByCall.current[card.toolCallId]?.trim();
		await send(
			{
				type: "answer",
				toolCallId: card.toolCallId,
				answer: {
					kind: card.kind,
					tool: card.tool,
					questionType: card.questionType,
					questionText: card.question,
					options: card.options?.map((option, index) => ({ index: index + 1, label: option.label })),
					dontKnow,
					answers: dontKnow
						? []
						: selected.map((value, i) => {
								const index = card.options?.findIndex((candidate) => candidate.value === value) ?? -1;
								return {
									label: index >= 0 ? card.options![index]!.label : value,
									value,
									index: index >= 0 ? index + 1 : i + 1,
								};
							}),
					thinking: thinking || undefined,
					answeredAt: new Date().toISOString(),
				},
			},
			undefined,
		);
		delete selectedByCall.current[card.toolCallId];
		delete thinkingByCall.current[card.toolCallId];
		delete dontKnowByCall.current[card.toolCallId];
		forceRender((n) => n + 1);
	};

	const entries: Entry[] = (view?.messages ?? []).map((message) => ({
		key: message.id,
		kind: message.role,
		text: message.text,
	}));
	const pending = view?.pendingQuestions ?? [];
	const busy = view?.busy ?? false;

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<StatusBar style="light" />
			<View style={styles.header}>
				<Pressable onPress={onBack} hitSlop={8}>
					<Text style={styles.back}>‹ Назад</Text>
				</Pressable>
				<Text style={styles.title} numberOfLines={1}>
					{title}
				</Text>
				{busy ? (
					<Pressable style={styles.abort} onPress={() => void api.abortTurn(chatId)}>
						<Text style={styles.abortText}>Стоп</Text>
					</Pressable>
				) : (
					<View style={{ width: 44 }} />
				)}
			</View>

			{view?.compacting ? (
				<View style={styles.banner}>
					<Text style={styles.bannerText}>Сжимаю контекст…</Text>
				</View>
			) : null}
			{view?.turnFailure ? (
				<View style={[styles.banner, styles.bannerError]}>
					<Text style={styles.bannerText}>{view.turnFailure}</Text>
					<Pressable onPress={() => void send({ type: "retry" })}>
						<Text style={styles.retry}>Повторить</Text>
					</Pressable>
				</View>
			) : null}

			<FlatList
				data={[...entries, ...pending.map((card) => ({ key: `q-${card.toolCallId}`, kind: "question" as const, card }))]}
				keyExtractor={(entry) => entry.key}
				contentContainerStyle={{ padding: spacing.m, gap: spacing.s, paddingBottom: spacing.xl }}
				ListEmptyComponent={
					view ? <Text style={styles.empty}>Сессия пуста — напиши, что хочешь изучить.</Text> : <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
				}
				renderItem={({ item }) =>
					item.kind === "question" ? (
						<QuestionCard
							card={item.card}
							busy={sending}
							selected={selectedByCall.current[item.card.toolCallId] ?? []}
							onToggle={(value) => {
								const current = selectedByCall.current[item.card.toolCallId] ?? [];
								const next =
									item.card.mode === "multi-select"
										? current.includes(value)
											? current.filter((candidate) => candidate !== value)
											: [...current, value]
										: [value];
								selectedByCall.current[item.card.toolCallId] = next;
								forceRender((n) => n + 1);
							}}
							thinking={thinkingByCall.current[item.card.toolCallId] ?? ""}
							onThinking={(text) => {
								thinkingByCall.current[item.card.toolCallId] = text;
							}}
							onSubmit={(dontKnow) => void answerQuestion(item.card, dontKnow)}
						/>
					) : item.kind === "divider" ? (
						<View style={styles.divider}>
							<Text style={styles.dividerText}>{item.text}</Text>
						</View>
					) : item.kind === "user" ? (
						<View style={[styles.bubble, styles.userBubble]}>
							<Text style={styles.userText}>{item.text}</Text>
						</View>
					) : (
						<View style={[styles.bubble, styles.assistantBubble]}>
							<Text style={styles.assistantText}>{item.text}</Text>
						</View>
					)
				}
			/>

			{loadError ? <Text style={styles.error}>{loadError}</Text> : null}

			<View style={styles.composer}>
				<TextInput
					style={styles.input}
					value={draft}
					onChangeText={setDraft}
					placeholder={busy ? "Урок идёт…" : "Сообщение учителю…"}
					placeholderTextColor={colors.dim}
					editable={!busy}
					multiline
				/>
				<Pressable
					style={[styles.send, (!draft.trim() || busy || sending) && styles.disabled]}
					disabled={!draft.trim() || busy || sending}
					onPress={() => {
						const text = draft.trim();
						setDraft("");
						void send({ type: "text", text }, text);
					}}
				>
					{sending ? <ActivityIndicator size="small" color="#0b0f16" /> : <Text style={styles.sendText}>↑</Text>}
				</Pressable>
			</View>
		</KeyboardAvoidingView>
	);
}

function QuestionCard({
	card,
	selected,
	onToggle,
	thinking,
	onThinking,
	onSubmit,
	busy,
}: {
	card: PendingQuestion;
	selected: string[];
	onToggle: (value: string) => void;
	thinking: string;
	onThinking: (text: string) => void;
	onSubmit: (dontKnow: boolean) => void;
	busy: boolean;
}) {
	const isText = card.mode === "text" || !card.options || card.options.length === 0;
	return (
		<View style={styles.card}>
			<Text style={styles.cardTool}>
				{card.tool === "probe" || card.tool === "recall" ? "Probe" : card.tool === "explain" ? "Explain" : "Quiz"}
				{card.questionType ? ` · ${card.questionType}` : ""}
			</Text>
			<Text style={styles.cardQuestion}>{card.question}</Text>
			{card.context ? <Text style={styles.cardContext}>{card.context}</Text> : null}

			{!isText &&
				card.options!.map((option) => {
					const isSelected = selected.includes(option.value);
					return (
						<Pressable
							key={option.value}
							style={[styles.option, isSelected && styles.optionSelected]}
							onPress={() => onToggle(option.value)}
						>
							<View style={[styles.radio, isSelected && styles.radioSelected]} />
							<Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>{option.label}</Text>
						</Pressable>
					);
				})}

			{isText || card.mode === "multi-select" || card.kind === "ask" ? (
				<TextInput
					style={[styles.thinkingInput, isText && styles.textAnswer]}
					value={thinking}
					onChangeText={onThinking}
					placeholder={isText ? "Твой ответ…" : "Дополнить мысль…"}
					placeholderTextColor={colors.dim}
					multiline
					editable={!busy}
				/>
			) : null}

			<View style={styles.cardActions}>
				<Pressable
					style={[styles.submit, busy && styles.disabled]}
					disabled={busy}
					onPress={() => onSubmit(false)}
				>
					<Text style={styles.submitText}>Ответить</Text>
				</Pressable>
				<Pressable style={[styles.dontKnow, busy && styles.disabled]} disabled={busy} onPress={() => onSubmit(true)}>
					<Text style={styles.dontKnowText}>Не знаю</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 44 },
	header: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.m, paddingBottom: spacing.s, gap: spacing.m },
	back: { color: colors.accent, fontSize: 15 },
	title: { color: colors.text, fontSize: 16, fontWeight: "700", flex: 1, textAlign: "center" },
	abort: { borderColor: colors.err, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, width: 44 },
	abortText: { color: colors.err, fontSize: 12, textAlign: "center" },
	banner: { flexDirection: "row", alignItems: "center", gap: spacing.m, backgroundColor: colors.surface, marginHorizontal: spacing.m, marginBottom: spacing.s, borderRadius: 8, padding: 10 },
	bannerError: { backgroundColor: "#2a1518" },
	bannerText: { color: colors.text, fontSize: 12, flex: 1 },
	retry: { color: colors.accent, fontSize: 13, fontWeight: "600" },
	empty: { color: colors.dim, textAlign: "center", marginTop: spacing.xl },
	bubble: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, maxWidth: "88%" },
	userBubble: { backgroundColor: colors.accentDim, alignSelf: "flex-end" },
	assistantBubble: { backgroundColor: colors.surface, alignSelf: "flex-start" },
	userText: { color: colors.text, fontSize: 15, lineHeight: 21 },
	assistantText: { color: colors.text, fontSize: 15, lineHeight: 22 },
	divider: { alignItems: "center", paddingVertical: spacing.s },
	dividerText: { color: colors.dim, fontSize: 11, letterSpacing: 1 },
	card: { backgroundColor: colors.surface, borderColor: colors.accentDim, borderWidth: 1, borderRadius: 12, padding: spacing.m, gap: spacing.s },
	cardTool: { color: colors.accent, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: "700" },
	cardQuestion: { color: colors.text, fontSize: 16, fontWeight: "600", lineHeight: 22 },
	cardContext: { color: colors.dim, fontSize: 13, lineHeight: 19 },
	option: { flexDirection: "row", alignItems: "center", gap: spacing.s, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12 },
	optionSelected: { borderColor: colors.accent, backgroundColor: "#10203a" },
	radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.dim },
	radioSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
	optionText: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 20 },
	optionTextSelected: { fontWeight: "600" },
	thinkingInput: { borderColor: colors.border, borderWidth: 1, borderRadius: 10, color: colors.text, padding: 12, fontSize: 14, minHeight: 40, textAlignVertical: "top" },
	textAnswer: { minHeight: 90 },
	cardActions: { flexDirection: "row", gap: spacing.s },
	submit: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20, flex: 1, alignItems: "center" },
	disabled: { opacity: 0.5 },
	submitText: { color: "#0b0f16", fontWeight: "700", fontSize: 15 },
	dontKnow: { borderColor: colors.border, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
	dontKnowText: { color: colors.dim, fontSize: 14 },
	composer: { flexDirection: "row", gap: spacing.s, padding: spacing.m, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, alignItems: "flex-end" },
	input: {
		flex: 1,
		backgroundColor: colors.surface,
		borderColor: colors.border,
		borderWidth: 1,
		borderRadius: 10,
		color: colors.text,
		paddingHorizontal: 14,
		paddingVertical: 10,
		fontSize: 15,
		maxHeight: 120,
	},
	send: { backgroundColor: colors.accent, borderRadius: 10, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
	sendText: { color: "#0b0f16", fontSize: 22, fontWeight: "700" },
	error: { color: colors.err, fontSize: 12, paddingHorizontal: spacing.m, paddingBottom: spacing.s },
});

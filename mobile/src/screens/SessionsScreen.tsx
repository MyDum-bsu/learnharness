import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Api, type BootstrapChat } from "../lib/api";
import { colors, spacing } from "../theme";

/**
 * THE SESSION LIST (mobile wave, 2026-11-04): the /api/v1/bootstrap chats
 * — live flags included — with pull-to-refresh, a light poll, and a
 * new-session composer. Tapping a session opens the lesson.
 */

export function SessionsScreen({
	api,
	deviceName,
	onOpenChat,
	onDisconnect,
}: {
	api: Api;
	deviceName: string;
	onOpenChat: (chatId: string, title: string) => void;
	onDisconnect: () => void;
}) {
	const [chats, setChats] = useState<BootstrapChat[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);
	const [draft, setDraft] = useState("");
	const [creating, setCreating] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const bootstrap = await api.bootstrap();
			setChats(bootstrap.chats);
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось обновить");
		} finally {
			setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		void refresh();
		const poll = setInterval(() => void refresh(), 5000);
		return () => clearInterval(poll);
	}, [refresh]);

	const create = async () => {
		const title = draft.trim();
		if (!title || creating) return;
		setCreating(true);
		try {
			const chat = await api.createSession(title);
			setDraft("");
			onOpenChat(chat.id, chat.title);
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось создать сессию");
		} finally {
			setCreating(false);
		}
	};

	return (
		<View style={styles.screen}>
			<StatusBar style="light" />
			<View style={styles.header}>
				<View style={{ flex: 1 }}>
					<Text style={styles.title}>LearnHarness</Text>
					<Text style={styles.device}>{deviceName}</Text>
				</View>
				<Pressable onPress={onDisconnect} hitSlop={8}>
					<Text style={styles.disconnect}>Выйти</Text>
				</Pressable>
			</View>

			<View style={styles.composer}>
				<TextInput
					style={styles.input}
					value={draft}
					onChangeText={setDraft}
					placeholder="Что хочешь изучить?"
					placeholderTextColor={colors.dim}
					onSubmitEditing={() => void create()}
					returnKeyType="go"
				/>
				<Pressable style={[styles.create, (!draft.trim() || creating) && styles.disabled]} onPress={() => void create()}>
					<Text style={styles.createText}>+</Text>
				</Pressable>
			</View>

			{error ? <Text style={styles.error}>{error}</Text> : null}

			<FlatList
				data={chats}
				keyExtractor={(chat) => chat.id}
				refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.dim} />}
				contentContainerStyle={{ paddingBottom: spacing.xl }}
				renderItem={({ item }) => (
					<Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={() => onOpenChat(item.id, item.title)}>
						<View style={{ flex: 1 }}>
							<Text style={styles.rowTitle} numberOfLines={2}>
								{item.title || "Untitled session"}
							</Text>
							<Text style={styles.rowMeta}>
								{relativeTime(item.updatedAt)}
								{item.pendingQuestion ? "  ·  вопрос ждёт ответа" : ""}
								{item.busy ? "  ·  идёт урок" : ""}
							</Text>
						</View>
						{item.pendingQuestion ? <View style={styles.dot} /> : item.busy ? <View style={[styles.dot, styles.dotBusy]} /> : null}
					</Pressable>
				)}
				ListEmptyComponent={
					loading ? null : <Text style={styles.empty}>Пока пусто. Начни первый урок сверху.</Text>
				}
			/>
		</View>
	);
}

function relativeTime(iso: string): string {
	const delta = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(delta / 60000);
	if (minutes < 1) return "только что";
	if (minutes < 60) return `${minutes} мин назад`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} ч назад`;
	return `${Math.floor(hours / 24)} дн назад`;
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 48 },
	header: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.l, paddingBottom: spacing.m },
	title: { color: colors.text, fontSize: 22, fontWeight: "700" },
	device: { color: colors.dim, fontSize: 12, marginTop: 2 },
	disconnect: { color: colors.err, fontSize: 14 },
	composer: { flexDirection: "row", gap: spacing.s, paddingHorizontal: spacing.l, paddingBottom: spacing.m },
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
	},
	create: {
		backgroundColor: colors.accent,
		borderRadius: 10,
		width: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	disabled: { opacity: 0.5 },
	createText: { color: "#0b0f16", fontSize: 24, fontWeight: "700" },
	error: { color: colors.err, fontSize: 12, paddingHorizontal: spacing.l, paddingBottom: spacing.s },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: spacing.m,
		paddingHorizontal: spacing.l,
		paddingVertical: 14,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	rowPressed: { backgroundColor: colors.surface },
	rowTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
	rowMeta: { color: colors.dim, fontSize: 12, marginTop: 4 },
	dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
	dotBusy: { backgroundColor: colors.ok },
	empty: { color: colors.dim, textAlign: "center", marginTop: spacing.xl, fontSize: 14 },
});

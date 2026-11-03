import { useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Image,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Api, ApiError } from "../lib/api";
import { normalizeServerUrl, saveConnection, type SavedConnection } from "../lib/store";
import { colors, spacing } from "../theme";

/**
 * THE CONNECTION PAGE (mobile wave, 2026-11-04) — the Orca-style first
 * screen: server address + one-time pairing code, or a scanned QR deep
 * link (learnharness://pair?server=…&code=…) that pre-fills both. The
 * code is minted by the desktop app (Settings → Devices) and lives for
 * five minutes.
 */

export interface PairPrefill {
	server?: string;
	code?: string;
}

export function ConnectScreen({
	onConnected,
	initialPair,
}: {
	onConnected: (connection: SavedConnection) => void;
	initialPair?: PairPrefill | null;
}) {
	const [server, setServer] = useState(initialPair?.server ?? "");
	const [code, setCode] = useState(initialPair?.code ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const autoSubmitted = useRef(false);

	const connect = async (rawServer: string, rawCode: string) => {
		if (busy) return;
		setError(undefined);
		const serverUrl = normalizeServerUrl(rawServer);
		if (!serverUrl) {
			setError("Адрес сервера не похож на http(s) URL");
			return;
		}
		const trimmedCode = rawCode.trim().toUpperCase();
		if (trimmedCode.length < 6) {
			setError("Код подключения — 8 символов из десктоп-приложения");
			return;
		}
		setBusy(true);
		try {
			const pair = await Api.pair(serverUrl, trimmedCode);
			const connection: SavedConnection = { serverUrl, token: pair.token, deviceName: pair.name };
			await saveConnection(connection);
			onConnected(connection);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "Сервер недоступен — проверь адрес и Tailscale");
		} finally {
			setBusy(false);
		}
	};

	// A scanned QR deep link connects on arrival — once.
	useEffect(() => {
		if (autoSubmitted.current || !initialPair?.server || !initialPair?.code) return;
		autoSubmitted.current = true;
		void connect(initialPair.server, initialPair.code);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialPair]);

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<StatusBar style="light" />
			<View style={styles.card}>
				<Image source={require("../../assets/icon.png")} style={styles.logo} resizeMode="contain" />
				<Text style={styles.title}>LearnHarness</Text>
				<Text style={styles.subtitle}>Подключение к твоему серверу обучения</Text>

				<Text style={styles.label}>Адрес сервера</Text>
				<TextInput
					style={styles.input}
					value={server}
					onChangeText={setServer}
					placeholder="http://100.x.y.z:3311 — адрес из Tailscale"
					placeholderTextColor={colors.dim}
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
					editable={!busy}
				/>

				<Text style={styles.label}>Код подключения</Text>
				<TextInput
					style={[styles.input, styles.codeInput]}
					value={code}
					onChangeText={(text) => setCode(text.toUpperCase())}
					placeholder="XXXXXXXX"
					placeholderTextColor={colors.dim}
					autoCapitalize="characters"
					autoCorrect={false}
					maxLength={8}
					editable={!busy}
				/>

				<Pressable
					style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, busy && styles.buttonDisabled]}
					disabled={busy}
					onPress={() => void connect(server, code)}
				>
					{busy ? <ActivityIndicator color="#0b0f16" /> : <Text style={styles.buttonText}>Подключиться</Text>}
				</Pressable>

				{error ? <Text style={styles.error}>{error}</Text> : null}

				<Text style={styles.hint}>
					Код выдаёт десктоп-приложение: Settings → Devices → Pair a device. Телефон и сервер — в одной сети
					Tailscale. Код живёт 5 минут и сгорает после первой попытки.
				</Text>
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: spacing.l },
	card: { gap: spacing.s },
	logo: { width: 88, height: 88, alignSelf: "center", marginBottom: spacing.m },
	title: { color: colors.text, fontSize: 28, fontWeight: "700", textAlign: "center" },
	subtitle: { color: colors.dim, fontSize: 14, textAlign: "center", marginBottom: spacing.l },
	label: { color: colors.dim, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
	input: {
		backgroundColor: colors.surface,
		borderColor: colors.border,
		borderWidth: 1,
		borderRadius: 10,
		color: colors.text,
		paddingHorizontal: 14,
		paddingVertical: 12,
		fontSize: 16,
	},
	codeInput: { fontSize: 22, letterSpacing: 8, textAlign: "center", fontWeight: "600" },
	button: {
		backgroundColor: colors.accent,
		borderRadius: 10,
		paddingVertical: 14,
		alignItems: "center",
		marginTop: spacing.m,
	},
	buttonPressed: { opacity: 0.85 },
	buttonDisabled: { opacity: 0.6 },
	buttonText: { color: "#0b0f16", fontSize: 16, fontWeight: "700" },
	error: { color: colors.err, fontSize: 13, textAlign: "center", marginTop: spacing.s },
	hint: { color: colors.dim, fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: spacing.l },
});

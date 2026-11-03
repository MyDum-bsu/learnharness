import { useEffect, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Api } from "./lib/api";
import { clearConnection, loadConnection, type SavedConnection } from "./lib/store";
import { colors } from "./theme";
import { ConnectScreen, type PairPrefill } from "./screens/ConnectScreen";
import { SessionsScreen } from "./screens/SessionsScreen";
import { ChatScreen } from "./screens/ChatScreen";

/**
 * LearnHarness mobile (mobile wave, 2026-11-04): Connect → Sessions →
 * Chat. Deep link learnharness://pair?server=…&code=… pre-fills (and
 * auto-runs) the pairing — the QR the desktop shows lands here.
 */

type Screen = { name: "sessions" } | { name: "chat"; chatId: string; title: string };

export default function App() {
	const [connection, setConnection] = useState<SavedConnection | null>(null);
	const [ready, setReady] = useState(false);
	const [screen, setScreen] = useState<Screen>({ name: "sessions" });
	const [pairPrefill, setPairPrefill] = useState<PairPrefill | null>(null);
	const [pairNonce, setPairNonce] = useState(0);

	// Load the saved connection, then watch for pair deep links. A link that
	// arrives while ALREADY connected re-pairs (the owner minted a new code).
	useEffect(() => {
		void (async () => {
			setConnection(await loadConnection());
			setReady(true);
		})();
		const handler = (event: { url: string }) => {
			const parsed = parsePairUrl(event.url);
			if (!parsed) return;
			setPairPrefill(parsed);
			setPairNonce((nonce) => nonce + 1);
			setScreen({ name: "sessions" });
			if (!connection) setConnection(null); // stay on Connect until the exchange lands
		};
		const subscription = Linking.addEventListener("url", handler);
		void Linking.getInitialURL().then((url) => {
			const parsed = url ? parsePairUrl(url) : null;
			if (parsed) {
				setPairPrefill(parsed);
				setPairNonce((nonce) => nonce + 1);
			}
		});
		return () => subscription.remove();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (!ready) return null;

	const showConnect = !connection || pairNonce > 0;
	if (showConnect) {
		return (
			<ConnectScreen
				key={pairNonce}
				initialPair={pairPrefill}
				onConnected={(next) => {
					setConnection(next);
					setPairPrefill(null);
					setPairNonce(0);
					setScreen({ name: "sessions" });
				}}
			/>
		);
	}

	const api = new Api(connection.serverUrl, connection.token);

	return (
		<View style={styles.screen}>
			<StatusBar style="light" />
			{screen.name === "sessions" ? (
				<SessionsScreen
					api={api}
					deviceName={connection.deviceName}
					onOpenChat={(chatId, title) => setScreen({ name: "chat", chatId, title })}
					onDisconnect={() => {
						void clearConnection();
						setConnection(null);
					}}
				/>
			) : (
				<ChatScreen api={api} chatId={screen.chatId} title={screen.title} onBack={() => setScreen({ name: "sessions" })} />
			)}
		</View>
	);
}

function parsePairUrl(url: string): PairPrefill | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "learnharness:" || !parsed.pathname.startsWith("//pair")) return null;
		// learnharness://pair?server=…&code=… — host/path forms vary by
		// Android's URL parsing of custom schemes; read from BOTH search
		// params and the host form.
		const params = parsed.searchParams;
		const server = params.get("server") ?? (parsed.hostname ? `http://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}` : undefined);
		const code = params.get("code") ?? undefined;
		if (!server || !code) return null;
		return { server, code };
	} catch {
		return null;
	}
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	loading: { color: colors.dim, textAlign: "center", marginTop: 100, fontSize: 14 },
});

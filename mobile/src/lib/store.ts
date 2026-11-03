import * as SecureStore from "expo-secure-store";

/**
 * The paired connection, on the device keychain (mobile wave, 2026-11-04):
 * server URL + the device token the pairing exchange returned. Nothing
 * else is persisted — sessions always come from the server.
 */

export interface SavedConnection {
	serverUrl: string;
	token: string;
	deviceName: string;
}

const KEY = "lh.connection.v1";

export async function loadConnection(): Promise<SavedConnection | null> {
	const raw = await SecureStore.getItemAsync(KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as SavedConnection;
		if (typeof parsed.serverUrl !== "string" || typeof parsed.token !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function saveConnection(connection: SavedConnection): Promise<void> {
	await SecureStore.setItemAsync(KEY, JSON.stringify(connection));
}

export async function clearConnection(): Promise<void> {
	await SecureStore.deleteItemAsync(KEY);
}

export function normalizeServerUrl(input: string): string | null {
	const text = input.trim().replace(/\/+$/, "");
	if (!text) return null;
	const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

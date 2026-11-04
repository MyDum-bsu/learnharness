import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * THE DEVICES SECTION (mobile wave, 2026-11-04): pair a phone (one-time
 * code → QR the phone's camera reads via the learnharness:// deep link),
 * list paired devices, revoke. The QR carries the address the app window
 * itself was loaded from — when the launcher binds the tailnet interface,
 * that IS the address the phone reaches over Tailscale.
 */

interface DeviceRow {
	id: string;
	name: string;
	scope: string;
	createdAt: string;
	expiresAt?: string;
	revokedAt?: string;
}

interface PendingRow {
	code: string;
	name: string;
	scope: string;
	expiresAt: string;
}

const card: React.CSSProperties = { border: "1px solid #1f2937", borderRadius: 10, padding: 16, display: "grid", gap: 12 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const muted: React.CSSProperties = { color: "#8b95a5", fontSize: 12 };
const button: React.CSSProperties = { background: "#4f8ef7", color: "#0b0f16", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 600, cursor: "pointer" };
const ghost: React.CSSProperties = { background: "transparent", color: "#f87171", border: "1px solid #2a1518", borderRadius: 8, padding: "6px 10px", cursor: "pointer" };

export function DevicesSection() {
	const [devices, setDevices] = useState<DeviceRow[]>([]);
	const [pending, setPending] = useState<PendingRow[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [qr, setQr] = useState<{ url: string; code: string } | undefined>(undefined);

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/devices");
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { devices: DeviceRow[]; pending: PendingRow[] };
			setDevices(body.devices.filter((device) => !device.revokedAt));
			setPending(body.pending);
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось загрузить устройства");
		}
	}, []);

	useEffect(() => {
		void refresh();
		const poll = setInterval(() => void refresh(), 5000);
		return () => clearInterval(poll);
	}, [refresh]);

	const pair = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const response = await fetch("/api/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ scope: "mobile", name: "Phone", origin: window.location.origin }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `HTTP ${response.status}`);
			}
			const minted = (await response.json()) as { code: string; pairingUrl: string };
			const url = await QRCode.toDataURL(minted.pairingUrl, {
				width: 280,
				margin: 1,
				color: { dark: "#0b0f16", light: "#ffffff" },
			});
			setQr({ url, code: minted.code });
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось создать код");
		} finally {
			setBusy(false);
		}
	};

	const revoke = async (id: string) => {
		setError(undefined);
		try {
			const response = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			setQr(undefined);
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось отозвать");
		}
	};

	return (
		<div style={{ display: "grid", gap: 16 }}>
			<p style={{ color: "#8b95a5", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
				Телефон подключается по коду из этой страницы (или сканом QR камерой) из любой сети — Tailscale на телефоне не нужен. Отзыв устройства отрезает ему доступ и push мгновенно.
			</p>

			<div style={row}>
				<button style={button} onClick={() => void pair()} disabled={busy}>
					{busy ? "…" : "Pair a phone"}
				</button>
				{pending.length > 0 ? <span style={muted}>Ждёт обмена: {pending.map((row) => row.code).join(", ")}</span> : null}
			</div>

			{error ? <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>{error}</p> : null}

			{qr ? (
				<div style={card}>
					<div style={row}>
						<img src={qr.url} alt="Pairing QR" width={180} height={180} style={{ borderRadius: 8 }} />
						<div style={{ display: "grid", gap: 6 }}>
							<Text style={{ color: "#e8ecf3", fontWeight: 700, fontSize: 20, letterSpacing: 4, margin: 0 }}>{qr.code}</Text>
							<span style={muted}>
								Камерой телефона — на QR, или введи код вручную на экране подключения. Код на 5 минут, одна
								попытка.
							</span>
						</div>
					</div>
				</div>
			) : null}

			<div style={{ display: "grid", gap: 8 }}>
				{devices.length === 0 ? <span style={muted}>Пока нет подключённых устройств.</span> : null}
				{devices.map((device) => (
					<div key={device.id} style={{ ...row, border: "1px solid #1f2937", borderRadius: 10, padding: 12 }}>
						<div style={{ flex: 1 }}>
							<div style={{ color: "#e8ecf3", fontWeight: 600 }}>
								{device.name} <span style={muted}>· {device.scope}</span>
							</div>
							<div style={muted}>
								с {new Date(device.createdAt).toLocaleDateString()}
								{device.expiresAt ? ` · токен до ${new Date(device.expiresAt).toLocaleDateString()}` : " · без срока"}
							</div>
						</div>
						<button style={ghost} onClick={() => void revoke(device.id)}>
							Отозвать
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

function Text(props: React.HTMLAttributes<HTMLParagraphElement>) {
	return <p {...props} />;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";

/**
 * THE DEVICES SECTION (pairing wave, 2026-11-02; restyled 2026-11-05 to the
 * settings design language — the same tokens as the other sections): pair
 * a phone (one-time code → QR the phone's camera reads via the
 * learnharness:// deep link), list paired devices, revoke. The QR carries
 * the address the app window itself was loaded from (the funnel URL when
 * the launcher publishes the app) — the phone pairs from any network.
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
	}, [refresh]);

	const pair = useCallback(async () => {
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
				color: { dark: "#141414", light: "#ffffff" },
			});
			setQr({ url, code: minted.code });
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось создать код");
		} finally {
			setBusy(false);
		}
	}, [refresh]);

	const revoke = useCallback(
		async (id: string) => {
			setError(undefined);
			await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
			setQr(undefined);
			void refresh();
		},
		[refresh],
	);

	return (
		<div className="flex flex-col gap-4">
			<p className="m-0 font-ui text-xs leading-relaxed text-muted-foreground">
				Телефон подключается сканом QR (или вручную: адрес + код) из любой сети — Tailscale на телефоне не
				нужен. Отзыв устройства отрезает ему доступ и push мгновенно.
			</p>

			<div className="flex items-center gap-3">
				<Button onClick={() => void pair()} disabled={busy}>
					{busy ? "…" : "Pair a phone"}
				</Button>
				{pending.length > 0 ? (
					<span className="font-mono text-xs text-muted-foreground">
						ждёт обмена: {pending.map((row) => row.code).join(", ")}
					</span>
				) : null}
			</div>

			{error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}

			{qr ? (
				<div
					className="flex items-center gap-4 rounded-sm border border-border bg-background p-3"
					data-testid="pairing-qr"
				>
					<img src={qr.url} alt="Pairing QR" width={180} height={180} className="rounded-sm" />
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="font-mono text-xl font-semibold tracking-[0.3em] text-foreground">{qr.code}</div>
						<div className="text-xs text-muted-foreground">
							Камерой телефона — на QR, или введи код вручную на экране подключения. Код на 5 минут, одна
							попытка.
						</div>
					</div>
				</div>
			) : null}

			{devices.length === 0 ? (
				<span className="font-ui text-xs text-muted-foreground">Пока нет подключённых устройств.</span>
			) : null}
			{devices.map((device) => (
				<div
					key={device.id}
					className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs"
				>
					<div className="min-w-0 flex-1">
						<div className="font-mono text-foreground">
							{device.name} <span className="text-muted-foreground">· {device.scope}</span>
						</div>
						<div className="text-muted-foreground">
							с {new Date(device.createdAt).toLocaleDateString()}
							{device.expiresAt ? ` · токен до ${new Date(device.expiresAt).toLocaleDateString()}` : " · без срока"}
						</div>
					</div>
					<Button variant="ghost" onClick={() => void revoke(device.id)}>
						Отзыв
					</Button>
				</div>
			))}
		</div>
	);
}

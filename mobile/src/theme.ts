/**
 * The mobile theme (design-alignment wave, 2026-11-05): the DESKTOP's own
 * tokens from app/globals.css (:root) — the phone is the same product, not
 * a different-looking one. Blue accents are gone; the primary action is
 * the desktop's light-on-dark button; inputs and cards use the same
 * #1c1c1c/#434343 inks.
 */

export const colors = {
	bg: "#141414",
	surface: "#1c1c1c",
	surfaceAlt: "#0f0f0f",
	border: "#434343",
	text: "#e6e6e6",
	dim: "#8d8d8d",
	/** The app's --primary (light) — the actionable color. */
	accent: "#e6e6e6",
	/** Text on the accent. */
	accentText: "#141414",
	/** The subtle highlighted surface (user bubble, selected option). */
	accentDim: "#2a2a2a",
	ok: "#a3b8a3",
	err: "#e0766b",
};

export const spacing = { s: 8, m: 16, l: 24, xl: 32 };

/**
 * THE UNREF-ABLE TIMER SEAM (2026-11-04): the ambient scope's setTimeout
 * loses Node's Timeout type (lib.dom shadows it; node:timers' own ambient
 * typing follows), and several callers require `.unref()`. The runtime
 * object IS Node's Timeout either way — the cast keeps the statics honest
 * under any type-lib arrangement.
 */
export function setCoreTimeout(callback: () => void, ms: number): NodeJS.Timeout {
	return setTimeout(callback, ms) as unknown as NodeJS.Timeout;
}

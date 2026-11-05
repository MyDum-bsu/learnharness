/**
 * THE SLASH GRAMMAR (skills wave, 2026-11-05): `/name` or `/name args` in
 * the composer expands into the skill's instruction body. Pure + sync —
 * the fetch of bodies is the caller's (the store IS local).
 */

export type SlashOutcome =
	| { kind: "none" } // the text is not a slash invocation — use as-is
	| { kind: "unknown"; name: string } // a /command with no matching skill
	| { kind: "ok"; name: string; args: string; expanded: string };

export const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/** One expansion: `/name` → the body; `/name args` → the body with
 *  $ARGUMENTS replaced (or the args appended to the end). */
export function expandSlash(text: string, skills: Map<string, string>): SlashOutcome {
	const match = /^\/([a-z0-9][a-z0-9-]{0,39})(?:\s+([\s\S]*))?$/.exec(text.trimStart());
	if (!match) return { kind: "none" };
	const name = match[1]!;
	const args = (match[2] ?? "").trim();
	const body = skills.get(name);
	if (body === undefined) return { kind: "unknown", name };
	const marker = ARGUMENTS_PLACEHOLDER;
	const expanded = body.includes(marker)
		? body.replaceAll(marker, args)
		: args
			? `${body.trimEnd()}\n\n---\nАргументы вызова:\n${args}`
			: body.trimEnd();
	return { kind: "ok", name, args, expanded };
}

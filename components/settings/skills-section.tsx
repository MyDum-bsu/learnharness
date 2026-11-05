"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * THE SKILLS SECTION (skills wave, 2026-11-05): the learner's own prompt
 * library — arbitrary Markdown bodies invoked in ANY composer as
 * `/name` or `/name аргументы` ($ARGUMENTS expands; no placeholder → the
 * argument appends). Management is owner-only.
 */

interface SkillRow {
	name: string;
	updatedAt: string;
	contentLength: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** One editor state for both create and edit paths. */
interface Editor {
	name: string; // empty when creating
	body: string;
}

export function SkillsSection() {
	const [skills, setSkills] = useState<SkillRow[]>([]);
	const [error, setError] = useState<string | undefined>(undefined);
	const [editor, setEditor] = useState<Editor | undefined>(undefined);

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/skills");
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { skills: SkillRow[] };
			setSkills(body.skills);
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось загрузить скиллы");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const save = useCallback(
		async (editor: Editor) => {
			setError(undefined);
			if (!NAME_RE.test(editor.name)) return;
			try {
				const response = await fetch("/api/skills", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: editor.name, content: editor.body }),
				});
				if (!response.ok) {
					const body = (await response.json().catch(() => ({}))) as { error?: string };
					throw new Error(body.error ?? `HTTP ${response.status}`);
				}
				setEditor(undefined);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : "не удалось сохранить");
			}
		},
		[refresh],
	);

	const remove = useCallback(async (name: string) => {
		setError(undefined);
		await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
		void refresh();
	}, []);

	const openExisting = useCallback(async (name: string) => {
		setError(undefined);
		try {
			const response = await fetch(`/api/skills/${encodeURIComponent(name)}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { content?: string };
			setEditor({ name, body: body.content ?? "" });
		} catch (err) {
			setError(err instanceof Error ? err.message : "не удалось открыть");
		}
	}, []);

	const isNew = (e?: Editor): boolean => !e?.name;

	return (
		<div className="flex flex-col gap-3">
			<p className="m-0 text-xs font-ui leading-relaxed text-muted-foreground">
				Библиотека своих промптов. В любом композере (десктоп, телефон):{" "}
				<code className="font-mono">/имя</code> или <code className="font-mono">/имя аргументы</code>. В теле
				скилла <code className="font-mono">$ARGUMENTS</code> заменяется аргументом; без плейсхолдера аргумент
				добавляется в конец.
			</p>

			{error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}

			{editor === undefined ? (
				<div>
					<Button
						variant="outline"
						onClick={() => setEditor({ name: "", body: "" })}
					>
						+ Новый скилл
					</Button>
				</div>
			) : (
				<div className="flex flex-col gap-2 rounded-sm border border-border bg-background p-2">
					{isNew(editor) ? (
						<input
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground"
							placeholder="имя-скилла (a-z, 0-9, дефис)"
							value={editor.name}
							onChange={(event) => setEditor({ ...editor, name: event.target.value.toLowerCase() })}
							autoFocus
						/>
					) : (
						<div className="font-mono text-xs text-muted-foreground">/{editor.name}</div>
					)}
					<textarea
						className="min-h-32 w-full rounded-sm border border-border bg-background p-1.5 font-mono text-xs text-foreground"
						placeholder={
							"Тело скилла — Markdown. Например:\nПроверь понимание темы $ARGUMENTS: 3 вопроса, сначала через слова ученика."
						}
						value={editor.body}
						onChange={(event) => setEditor({ ...editor, body: event.target.value })}
					/>
					<div className="flex gap-2">
						<Button
							data-testid="save-skill"
							onClick={() => void save(editor)}
						>
							Сохранить
						</Button>
						<Button
							variant="outline"
							onClick={() => setEditor(undefined)}
						>
							Отмена
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col gap-1">
				{skills.length === 0 ? (
					<span className="text-xs text-muted-foreground">Пока пусто. Создай первый скилл.</span>
				) : null}
				{skills.map((skill) => (
					<div
						key={skill.name}
						className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs"
					>
						<div className="min-w-0 flex-1">
							<button
								type="button"
								data-testid={`skill-${skill.name}`}
								className="font-mono text-foreground hover:text-primary"
								onClick={() => void openExisting(skill.name)}
							>
								/{skill.name}
							</button>
							<div className="text-muted-foreground">
								{skill.contentLength} симв · обновлён{" "}
								{new Date(skill.updatedAt).toLocaleDateString()}
							</div>
						</div>
						<Button variant="ghost" onClick={() => void remove(skill.name)}>
							Удалить
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}


# Negative control kit

`kit.patch` создаёт `src/agent/tools/fs-deny.ts` как заглушку «всегда разрешено»: guard не отказывает,
`redactSecrets` возвращает текст как есть.

Как проверяется невакуумность oracle:

1. Чистая база (до реализации) + `git apply kit.patch`.
2. `dod` из спеки должен **упасть**: падают тесты отказа (`.ssh`, `.env`, `auth.json`, `dataDir`,
   symlink), маскирования (`redactSecrets`, `capOutput`) и wiring-тест (модули `read`/`ls`/`find`/`grep`
   не вызывают guard).
3. Патч откатывается, реализация считается принятой только если `dod` зелёный без патча.

Если `dod` зелёный при наложенном `kit.patch`, oracle непригоден: он не отличает исправленное
поведение от заглушки.

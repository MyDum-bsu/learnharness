---
id: t-20261102-180424-закрыть-ssrf-в-web-fetch-и-web-f-ea0af4
title: Единый сетевой гард (https-only, блок приватных радиусов и DNS-резолвов, редиректы, Jina) для web_fetch и web_fetch_pdf
risk: medium
auto_approve: false
deps: []
allowed_paths:
  - src/agent/tools/net-guard.ts
  - src/agent/tools/web.ts
  - src/agent/tools/pdf-read.ts
  - tests/web-net-guard.test.ts
oracle_paths:
  - oracle/t-20261102-180424-закрыть-ssrf-в-web-fetch-и-web-f-ea0af4/web-fetch-ssrf.test.ts
gate_inputs:
  - package.json
  - tsconfig.json
  - eslint.config.mjs
invariants:
  - Ни один запрос к приватному/loopback/link-local адресу не покидает процесс — ни в первом хопе, ни после редиректа.
  - Проверенный адрес и набираемый адрес — один и тот же DNS-резолв (нет окна для rebinding).
  - Каждый хоп редиректа проходит ту же политику, что и исходный URL; число хопов ограничено.
  - Отказ всегда возвращается строкой результата инструмента, а не исключением в агентский цикл.
  - Jina Reader вызывается только после успешного прохождения политики целевым URL.
properties:
  command: "NODE_ENV=test npx --no-install tsx --test oracle/t-20261102-180424-закрыть-ssrf-в-web-fetch-и-web-f-ea0af4/web-fetch-ssrf.test.ts"
  seeds: 16
skills:
  - ~/.agents/skills/technical-style-editor/SKILL.md
dod: "NODE_ENV=test npx --no-install tsx --test oracle/t-20261102-180424-закрыть-ssrf-в-web-fetch-и-web-f-ea0af4/web-fetch-ssrf.test.ts"
negative_control:
  corpus: oracle/negative/t-20261102-180424-закрыть-ssrf-в-web-fetch-и-web-f-ea0af4/
---

# Spec

## Intent

`web_fetch` и `web_fetch_pdf` — единственные пути, которыми модель может заставить хост сходить по произвольному URL. Сейчас проверяется только схема, редиректы следуют молча, DNS не проверяется. В dev это даёт чтение `http://127.0.0.1:3000/api/chats` без заголовков и в связке с `read` и prompt injection складывается в эксфильтрацию. Нужен один гард-модуль и подключение его в оба инструмента; никакой другой политики в репозитории не появляется.

### Обязательный контракт гарда (`src/agent/tools/net-guard.ts`)

```ts
export interface NetDeps {
  /** Резолвер; по умолчанию — dns.lookup с { all: true }. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Транспорт; по умолчанию — undici fetch. */
  transport?: typeof fetch;
}
export function isBlockedAddress(ip: string): boolean;
export function assertUrlPolicy(input: string): URL;      // https-only + литерал-хост
export async function guardedFetch(input: string, deps?: NetDeps): Promise<Response>; // ручной follow, <=5 хопов
export const NET_GUARD_MAX_REDIRECTS = 5;
```

Порядок внутри `guardedFetch`: разобрать URL → `assertUrlPolicy` → `deps.lookup` → отклонить, если любой адрес `isBlockedAddress` → передать тот же резолв в соединение (undici `Agent` с `connect.lookup`, пиннинг: резолв не повторяется) → при `3xx` читать `Location`, считать следующий абсолютный URL и повторить всю цепочку, включая проверку адреса. Приватные диапазоны: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `192.0.0/24`, `192.0.2/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `::1`, `::`, `fc00::/7`, `fe80::/10`, `ff00::/8`, и IPv4-mapped формы (`::ffff:a.b.c.d`). Не-IP литерал хостнейма проходит только если это DNS-имя и адрес после резолва публичный; `localhost`, `localhost.`, `*.localhost`, `*.local` блокируются по имени до резолва.

## Given

- `src/agent/tools/web.ts`: `web_fetch` проверяет только `protocol` и вызывает `fetchAndExtract`, где `fetch` следует редиректам сам; `fetchViaJina` ходит в `https://r.jina.ai/<url>` для любого URL.
- `src/agent/tools/pdf-read.ts`: `web_fetch_pdf` так же проверяет только схему и скачивает тело в per-job temp dir.
- Контракт инструментов: никогда не бросать в агентский цикл, всегда возвращать строку ошибки (шапка `web.ts`).
- Тестовый раннер репозитория: `NODE_ENV=test tsx --test tests/*.test.ts`.

## When

Воркер реализует гард и переводит на него оба инструмента:

1. Создать `src/agent/tools/net-guard.ts` с контрактом выше. Политика — только `https:`; порт не ограничивается, но хост проходит только по правилам адресов.
2. В `web_fetch`: заменить `try { new URL(url); protocol-check }` на `assertUrlPolicy`, а `fetch` внутри `fetchAndExtract` — на `guardedFetch`. Невалидный URL и отказ политики — разные сообщения (`invalid URL` vs `blocked address`/`only https is allowed`), оба возвращаются строкой.
3. `fetchViaJina` вызывать только после успешного `guardedFetch` целевого URL и только для того же URL, который прошёл политику; сам вызов Jina идёт через `guardedFetch` (`https://r.jina.ai/...`).
4. В `web_fetch_pdf`: та же замена — `assertUrlPolicy` + `guardedFetch`; при отказе политики файл не создаётся.
5. Добавить свои unit-тесты в `tests/web-net-guard.test.ts` (по желанию, но не вместо oracle).

Запрещено менять `oracle_paths`, подкручивать политику под тесты, добавлять env-переключатели или allowlist.

## Then

- `dod` зелёный: все кейсы oracle проходят.
- `http://127.0.0.1:3000/api/chats` (и `https://` вариант, и `https://localhost:PORT`) через `web_fetch` возвращает отказ, локальный сервер не получает запросов.
- Редирект на `https://127.0.0.1:3000/api/chats` блокируется на втором хопе, транспорт вызывается один раз.
- DNS-имя, резолвящееся в `127.0.0.1`, блокируется до соединения.
- Внешний `https` проходит политику (проверяется фейковым транспортом в oracle).
- `npm test` (существующий набор) остаётся зелёным; `npm run typecheck` чистый.

## Forbidden

- Оставлять голый `fetch` хотя бы на одном пути (`fetchAndExtract`, `fetchViaJina`, PDF-скачивание).
- Проверять только литерал IP или только первый хоп URL.
- Резолвить хост отдельно для проверки и отдельно для соединения (TOCTOU/rebinding).
- Хардкодить ответы, глушить ошибки `catch {}`, вводить env-флаги вида `LH_NET_GUARD_OFF`, allowlist для `localhost`.
- Менять `web_search`, `jobs.ts`, `src/core/contracts/jobs.ts`, серверные адаптеры, UI.
- Трогать `tests/` вне `tests/web-net-guard.test.ts` и любые файлы вне `allowed_paths`.

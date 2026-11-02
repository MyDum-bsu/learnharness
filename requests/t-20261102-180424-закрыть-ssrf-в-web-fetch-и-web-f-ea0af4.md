---
id: t-20261102-180424-закрыть-ssrf-в-web-fetch-и-web-f-ea0af4
created: 2026-11-02T18:04:24+0300
source: plan-2026-11-02
source_id: p0-6
trust: untrusted
---

# Raw request

Закрыть SSRF в web_fetch и web_fetch_pdf: сейчас принимается любой http(s), включая loopback, LAN и link-local, и редиректы не проверяются. Ревью .agent/review-2026-11-02.md §3.6. В dev это позволяет агенту прочитать http://127.0.0.1:3000/api/chats без заголовков, а в связке с read и prompt injection складывается цепочка эксфильтрации секретов наружу. Evidence: src/agent/tools/web.ts:83-91,176-186 (проверка только protocol), src/agent/tools/pdf-read.ts:105-132, брифы уходят в user-канал: src/agent/tools/jobs.ts:128-140 и src/core/contracts/jobs.ts:350-353. Требование: блокировать private, loopback, link-local и их DNS-резолвы после каждого редиректа, DNS pinning, разрешать только внешние https, отключать Jina для приватных адресов. Приёмка: research-job с web_fetch на loopback получает отказ, включая редирект на loopback и адрес, резолвящийся в 127.0.0.1; внешний https по-прежнему работает. Риск medium. dod не должен содержать curl или wget: политика фабрики их не пропустит, используй node или vitest.

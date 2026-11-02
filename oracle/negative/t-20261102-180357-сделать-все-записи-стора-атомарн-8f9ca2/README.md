# Negative corpus — t-20261102-180357

`kit.patch` — правдоподобное частичное решение, которое oracle обязан отвергнуть.

Что делает kit: превращает `writeChat` в temp+rename, то есть закрывает симптом
«пустой `chats/<id>.json` после падения» для сессий.

Почему этого недостаточно и что должно упасть:

1. `store-atomic.test.ts` → «a corrupt record read fails loudly and list reads log it»:
   `getChat` по-прежнему ловит ошибку парсинга и возвращает `null`
   (`src/store/chats.ts:61-76`). Тест требует ошибку с путём к файлу — kit её не даёт.
2. `store-atomic.test.ts` → «store writes replace the file instead of truncating it in
   place»: `settings.json` и `jobs/<id>.json` не тронуты, пишутся на месте — inode
   не меняется.
3. Нет `fsync` ни файла, ни каталога, поэтому даже для чатов durability не выполнена,
   хотя crash-тест на падение процесса это и не различает.

Файл применяется как обычный git-патч к базовой ветке. Если патч не применяется
(сдвиг контекста в `src/store/chats.ts`), корпус считается отвергнутым по причине
«не воспроизводит целевую правку», и это тоже валидный исход для negative control —
он не должен проходить oracle.

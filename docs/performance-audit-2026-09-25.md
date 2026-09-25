# Аудит производительности tarkovstats.ru

**Дата:** 25 сентября 2026
**URL:** `https://tarkovstats.ru/`
**Метод:** Chrome DevTools MCP, Navigation Timing, Resource Timing, network waterfall, performance traces и controlled interactions.

## Краткий вывод

На холодном мобильном профиле LCP составляет **6.89 с — Poor**. **88.7% LCP** занимает загрузка одного hero-изображения размером **585 536 байт**. На desktop тот же файл даёт основную часть LCP, хотя итоговая метрика остаётся Good.

TTFB главного HTML-запроса стабильно низкий. Backend не является основным bottleneck. После исправления hero следующими узкими местами станут приоритет LCP-запроса, render-blocking CSS и client-side data waterfall.

## 1. Условия измерения

| Параметр | Desktop | Mobile controlled |
|---|---:|---:|
| Viewport | 1440×900 | 390×844 |
| DPR | 1 | 3 |
| CPU | 1× | 4× slowdown |
| Сеть | Fast 4G | Slow 4G |
| Режим | Desktop UA | Mobile viewport, desktop UA |
| Cold-прогонов | 3 | 3 |
| Warm-прогонов | 3 | 3 |

Дополнительно:

- Chrome `154.0.0.0`, Windows 10.
- 16 логических CPU, 32 ГБ RAM.
- Анонимная сессия.
- Cold: отдельный browser context, `ignoreCache: true`.
- Warm: повторная навигация с активным HTTP/Memory Cache.
- Публичные stacks, ресурсы, статистика и исходный код проверялись параллельно.
- CrUX/field data для страницы отсутствуют.

Cold не означает абсолютно холодный интернет: DNS, TLS и часть browser-process cache могут сохраняться.

## 2. Сводные результаты

Все значения — медиана из трёх лабораторных прогонов.

| Сценарий | TTFB | FCP | LCP | Load | CLS | Результат |
|---|---:|---:|---:|---:|---:|---|
| Desktop cold | **114.6 ms** | **732 ms** | **1 449 ms** | 1 357 ms | ≈0.0002 | Good |
| Desktop warm | **101.4 ms** | **304 ms** | **303 ms** | 301.5 ms | 0 | Good |
| Mobile cold | **104.5 ms** | **2 836 ms** | **6 892 ms** | 7 011 ms | 0 | LCP Poor |
| Mobile warm | **38.1 ms** | **832 ms** | **831 ms** | 961.1 ms | 0 | Good |

Ориентиры:

- TTFB: Good ≤800 ms.
- FCP: Good ≤1.8 s, Needs Improvement ≤3 s.
- LCP: Good ≤2.5 s, Needs Improvement ≤4 s, Poor >4 s.
- CLS: Good ≤0.1.
- INP: Good ≤200 ms.

Это лабораторные медианы, а не field p75.

## 3. Все прогоны

### Desktop cold

| Прогон | TTFB | FCP | LCP | Load |
|---|---:|---:|---:|---:|
| D1 | 104.9 ms | 616 ms | 1 449 ms | 1 357.0 ms |
| D2 | 131.9 ms | 740 ms | 1 483 ms | 1 771.3 ms |
| D3 | 114.6 ms | 732 ms | 1 442 ms | 1 344.3 ms |

Разброс LCP — всего 41 ms. Мобильная проблема не воспроизводится на desktop.

### Desktop warm

| Прогон | TTFB | FCP | LCP | Load |
|---|---:|---:|---:|---:|
| W1 | 101.4 ms | 304 ms | 303 ms | 301.5 ms |
| W2 | 109.1 ms | 308 ms | 307 ms | 327.1 ms |
| W3 | 42.7 ms | 236 ms | 234 ms | 253.8 ms |

Повторный запуск уменьшил LCP на **79.1%**, или на **1.15 s**.

### Mobile cold

| Прогон | TTFB | FCP | LCP | Load |
|---|---:|---:|---:|---:|
| M1 | 120.3 ms | 2 836 ms | 6 343 ms | 6 273.5 ms |
| M2 | 104.5 ms | 2 804 ms | 6 975 ms | 7 194.0 ms |
| M3 | 96.1 ms | 2 840 ms | 6 892 ms | 7 011.0 ms |

Все три LCP находятся в зоне Poor. Разброс 632 ms.

### Mobile warm

| Прогон | TTFB | FCP | LCP | Load |
|---|---:|---:|---:|---:|
| W1 | 102.3 ms | 868 ms | 864 ms | 1 279.6 ms |
| W2 | 38.1 ms | 784 ms | 784 ms | 928.4 ms |
| W3 | 35.7 ms | 832 ms | 831 ms | 961.1 ms |

Кэширование hero уменьшило мобильный LCP на **87.9%**, или на **6.06 s**.

## 4. Navigation Timing

Подробные фазы были сняты в representative desktop cold run:

| Фаза | Время |
|---|---:|
| Redirect | 0 ms |
| DNS | 12.1 ms |
| TCP connect | 47.4 ms |
| TLS | 27.6 ms |
| Request → first response byte | 43.9 ms |
| **TTFB** | **104.9 ms** |
| Загрузка HTML | 148.3 ms |
| Response end | 253.2 ms |
| DOM interactive | 554.8 ms |
| DOMContentLoaded | 555.0 ms |
| Load | 1 357.0 ms |
| Response end → DOM interactive | 301.6 ms |
| DCL → Load | 802.0 ms |

### Вывод по серверу

TTFB стабильно находится между **96 и 132 ms**. Серверная обработка главного HTML-запроса не является bottleneck.

После получения HTML браузеру требовалось:

- около 300 ms до интерактивного DOM;
- ещё около 800 ms до `load`, почти полностью из-за hero-изображения.

## 5. LCP breakdown

### Desktop cold

| Этап | Время | Доля LCP |
|---|---:|---:|
| TTFB | ≈115 ms | 7.9% |
| Resource load delay | ≈146 ms | 10.1% |
| **Resource load duration** | **≈1 096 ms** | **75.6%** |
| Element render delay | ≈99 ms | 6.8% |

### Mobile cold

| Этап | Время | Доля LCP |
|---|---:|---:|
| TTFB | ≈105 ms | 1.5% |
| Resource load delay | ≈594 ms | 8.6% |
| **Resource load duration** | **≈6 112 ms** | **88.7%** |
| Element render delay | ≈77 ms | 1.1% |

### LCP-ресурс

```text
https://tarkovstats.ru/_next/image?url=%2Fhome%2Ftarkov-key-art.webp&w=...
```

Факты:

- Desktop запросил `w=1080`.
- Mobile запросил `w=1200`.
- Оба ответа содержат **585 536 байт**.
- Hero занимает около **56.6%** desktop resource traffic и **61.2%** mobile traffic.
- Дополнительная проверка показала одинаковый файл и одинаковый SHA-256 для нескольких `w=640/1200/1920/3840`.
- Response содержит `X-Nextjs-Cache: HIT`.
- Cache header: `public, max-age=14400, must-revalidate`.
- Изображение непосредственно присутствует в initial HTML.
- `loading=lazy` не используется.
- Проверка `fetchpriority=high` — **FAILED**.
- Начальный приоритет preload — Low, позднее меняется на High.

### Оценка Chrome

Image Delivery:

- desktop: потенциальная экономия около **574–579 kB**;
- desktop LCP savings: около **500–550 ms**;
- mobile: потенциальная экономия около **583–591 kB**;
- mobile LCP savings: около **2.9–3.15 s**.

Это модель Chrome, а не результат A/B. Нельзя гарантировать такой выигрыш без проверки после изменения.

## 6. Network waterfall

### Объём

| Сценарий | Запросов | Transfer |
|---|---:|---:|
| Desktop cold | 48 | примерно 1.04 MB |
| Mobile cold | 35 | примерно 0.96 MB |
| Desktop warm | около 43 | 13–132 KB |
| Mobile warm | около 32 | 13–104 KB |

Cross-origin ресурсы без `Timing-Allow-Origin` показывают нулевой transfer в Resource Timing, поэтому итоговый трафик может быть немного выше.

### Основные типы ресурсов

Desktop cold:

- CSS: 3 файла, около **31.8 KB gzip**.
- Современный JS: 11–12 chunks, **227–237 KB gzip**.
- Hero: **585.5 KB**.
- Ниже-fold изображения: около 73 KB.
- API/fetch: около 88 KB.
- Favicon: около 9.8 KB.
- Декодированный объём: около **2.1 MB**.

### Самые долгие запросы desktop

| Ресурс | Длительность |
|---|---:|
| Hero image | **1 096 ms** |
| JS `0f071r…` | 868 ms |
| JS `2phkfh…` | 806 ms |
| JS `31iarpv…` | 694 ms |
| JS `3tvmy…` | 689 ms |
| JS `3m3hou…` | 669 ms |
| JS `139ipk…` | 668 ms |
| JS `11b31m…` | 607 ms |
| Achievement image | 476 ms |
| RSC prefetch | 375–396 ms |

### Самые долгие запросы mobile

| Ресурс | Длительность |
|---|---:|
| Hero image | **5 562–6 262 ms** |
| JS `31iarpv…` | 2 570–2 579 ms |
| JS `139ipk…` | 2 369–2 379 ms |
| JS `11b31m…` | 2 169–2 178 ms |
| Главный CSS | 1 743–1 753 ms |
| Остальные JS | 1.2–1.5 s |
| API profile | 673–713 ms |
| API timeline | 1.04–1.38 s; один outlier 25.33 s |
| API cohort | 0.60–1.28 s |

## 7. API waterfall и content readiness

Публичный код подтверждает следующую цепочку:

```text
HTML с loading placeholders
  → hydration
  → /api/home/showcase
  → следующий React commit
  → параллельно profile + timeline + cohort
  → Promise.all
  → один setSnapshot
  → весь showcase становится готовым
```

Это видно в [`components/HomePage.tsx`](../components/HomePage.tsx#L49-L110).

### Измеренные этапы

Desktop cold:

- `/api/home/showcase`: старт 1 146 ms, длительность 195 ms.
- Profile/timeline/cohort: старт около 1 346 ms.
- Profile: 210 ms.
- Timeline: 278 ms.
- Cohort: 182 ms.
- Portrait с redirect: около 401 ms.

Mobile cold:

- Hydration/API старт: около 3.6 s.
- Showcase: 579–593 ms.
- Profile: 673–713 ms.
- Timeline: 1.04 s, 1.38 s и **25.33 s** в одном run.
- Cohort: 0.60–1.28 s.

### Timeline outlier

Один запрос:

```text
/api/progression/timeline?aid=7978003...
```

занял **25.33 s**. В двух других холодных прогонах тот же endpoint отвечал за 1.04 и 1.38 s.

Это не причина самого LCP: запрос начинался уже после hero и длился значительно дольше LCP. Но из-за `Promise.all` он способен удерживать готовность profile, risk, comparison и графика вместе с timeline.

Точная причина 25-секундного хвоста не установлена: response не содержит `Server-Timing`. Возможные причины — cache miss, upstream `tarkov.dev`, SQLite/materializer или другой серверный этап. Это гипотезы, требующие серверной трассировки.

### Overfetch timeline

Homepage читает только:

- `xp.player`;
- `pvp_kd.player`;
- `survival.player`.

Из каждой точки используются только `seriesId`, `pmcRaids`, `level`, `value`, `observedAt`.

При этом endpoint возвращает **10 metrics**, а также `nearby`, `overall`, `history`, `risk`, `longTerm`, `comparison` и другие поля. Сборка полного ответа находится в [`lib/seasonal/progression-db.ts`](../lib/seasonal/progression-db.ts#L941-L984).

Это подтверждённый overfetch для главной страницы.

## 8. Render-blocking и FCP

Три CSS-файла блокируют первый render:

- `1qi1g3zadnabe.css`;
- `0mlwztxu-wet-.css`;
- `26bt0ij1ntv8a.css`.

Mobile Slow 4G:

| CSS | Длительность |
|---|---:|
| Главный CSS | 1 743–1 753 ms |
| Второй CSS | 853–960 ms |
| Третий CSS | завершение около 1 556 ms |

Chrome оценил возможное улучшение FCP на **134–147 ms**.

CSS не являются главной причиной LCP, поскольку LCP render delay — только 77–99 ms. Но они объясняют часть отставания FCP на mobile.

## 9. Main thread, layout и forced reflow

### DOM

- Desktop: **349–374 элемента**.
- Mobile: **353–372 элемента**.
- Глубина DOM: 13.
- Один SVG содержит 30–53 дочерних элемента.

### Layout updates

Desktop:

- один layout update около **47–48 ms**.

Mobile:

- **285–294 ms**, 189 nodes;
- **140–156 ms**, до 474 nodes.

### Forced reflow

Chrome зафиксировал:

- суммарный attributed reflow: **162–176 ms**;
- общие trigger frames: **312–324 ms**;
- top-level offender не определён.

Публичный код показывает вероятные паттерны:

- `getBoundingClientRect()` с последующей записью позиции tooltip в [`components/home/HomeComparison.tsx`](../components/home/HomeComparison.tsx#L89-L101);
- `ResizeObserver`, вызывающий React state update;
- одновременная замена loading placeholders несколькими тяжёлыми секциями.

Layout действительно дорогой, но его вклад именно в LCP ограничен: render delay LCP — 77–99 ms.

Long Tasks API не вернул записей. Поэтому утверждать, что существует отдельная длинная JS task >50 ms, нельзя.

## 10. CLS

Основной trace показывает CLS как `0.00` из-за округления.

CLSCulprits обнаружил:

- worst cluster: **0.0002**;
- время: около 3 813 ms;
- элемент: `.site-header__controls`;
- причина: `skeleton-shimmer`;
- анимируется `background-position-x`, который не composited.

Итог: CLS фактически около **0.0002**, Good. Исправлять скелетон имеет смысл только как точечную микрооптимизацию.

## 11. Интерактивность и INP

Выполнены реальные безопасные действия через Chrome DevTools MCP:

| Действие | Input delay | Processing | Presentation | Всего |
|---|---:|---:|---:|---:|
| Открытие мобильного меню | 4 ms | 8 ms | 17 ms | **29 ms** |
| Переключение метрики графика | 3 ms | 30 ms | 46 ms | **79 ms** |
| Переключение темы | недоступно | недоступно | недоступно | **104 ms** |
| Дополнительный combined trace | 4 ms | 8 ms | 162 ms | **174 ms** |

Все задержки ниже 200 ms, но это не field INP:

- каждый сценарий выполнен один раз;
- нет p75;
- нет реального распределения пользователей;
- основная проблема — presentation delay, а не input delay.

## 12. Сторонние ресурсы и ошибки

### Cloudflare Web Analytics

- Beacon загружался двумя network entries.
- Размер около **10.3 KB**.
- Main-thread execution: 6 ms desktop, 31 ms mobile.
- Console: preload не использовался из-за несовпадения credentials mode.
- В HTML нет согласованного `crossorigin`.
- `afterInteractive` скрипт дополнительно вызывает React preload.

Потенциальная конкуренция с hero есть, но её влияние на LCP не доказано. Сам third-party JS не является главной причиной.

### Остальное

- `/api/favorites?all=1` возвращает 401 для анонимного пользователя.
- Внешние шрифты отсутствуют.
- Реклама и chat widget не обнаружены.
- Legacy JS: около **24.5 KB**, потенциальный эффект 0–150 ms — низкий приоритет.
- Achievement icons загружаются по 11–15 KB каждый при отображении около 25–42 px.
- Portrait: 500×500 WebP около 21 KB при отображении 60–86 px.
- Favicon имеет `max-age=0`; в одном post-trace наблюдении его request занял 23.17 s, но он не относился к critical path.

## 13. Что именно вызывает задержки

| Приоритет | Причина | Доказательность | Влияние |
|---:|---|---|---|
| P0 | Hero WebP 585 536 B и одинаковый ответ для разных ширин | Подтверждено | 75.6% desktop LCP, 88.7% mobile LCP |
| P0 | `fetchpriority=high` отсутствует | Подтверждено; влияние — вероятное | До 146–594 ms load delay |
| P1 | Client-side API waterfall и атомарный `Promise.all` | Подтверждено кодом и trace | Задержка готовности секций |
| P1 | Timeline outlier 25.33 s | Подтверждено; внутренняя причина неизвестна | Критический хвост для одного игрока |
| P1 | Три render-blocking CSS | Подтверждено | FCP ≈134–147 ms |
| P2 | Forced reflow и дорогие layout updates | Подтверждено | 312–324 ms main-thread cost |
| P2 | Timeline возвращает 10 метрик вместо 3 | Подтверждено кодом | Лишний JSON, server work и parsing |
| P3 | Дублированный Cloudflare beacon | Подтверждено | Около 10 KB и лишний request |
| P3 | Некорректно приоритизированные small images | Подтверждено | Ниже-fold traffic |
| — | TTFB основного HTML | Высокая скорость | Не bottleneck |
| — | Fonts, CLS, external chat | Не обнаружены | Не являются причиной |

## 14. Рекомендации по приоритету

### P0 — исправить hero

1. Проверить, почему `/_next/image` возвращает исходный WebP вместо разных оптимизированных вариантов.
2. Создать реально различные варианты для 640/960/1280/1920 px.
3. Удалить кандидата `3840w`, если исходник уже меньше.
4. Снизить quality только после визуального A/B.
5. Добавить `fetchPriority="high"` к preload/LCP image.
6. Не использовать lazy loading для hero.
7. Проверять `Content-Length`, dimensions и SHA-256 каждого `srcset`-варианта.

Ожидаемый потенциал по Chrome:

- desktop: около 0.5 s;
- mobile: около 2.9–3.15 s.

Фактический выигрыш нужно подтвердить A/B.

### P1 — переработать API главной

1. Рендерить profile сразу после его ответа, не ожидая timeline и cohort.
2. Убрать общий `Promise.all` для независимых секций.
3. Добавить lean timeline endpoint для homepage: 3 metrics и 5 используемых полей.
4. Остальные метрики загружать лениво или только на полной странице профиля.
5. Добавить `Server-Timing` для cache hit/miss, upstream, DB, serialization.
6. Найти причину 25.33 s outlier.
7. Убрать клиентский `cache: "no-store"` у `/api/home/showcase`, если данные допускают публичный cache/revalidation.

### P1 — убрать render-blocking CSS

- Выделить critical CSS для первого экрана.
- Остальные стили загружать после первого render штатным механизмом Next.js.
- Проверять FCP, LCP, CLS и визуальные snapshots, чтобы не получить FOUC.

### P1 — сократить main-thread layout

- Не монтировать тяжёлые below-fold графики до приближения к viewport.
- Группировать DOM reads перед DOM writes.
- Не вызывать `getBoundingClientRect()` после изменения DOM в том же обработчике.
- Вынести изменение ширины графиков из синхронного layout path.
- Использовать `transform`/`opacity` вместо layout-свойств для анимаций.

### P2 — исправить analytics preload

- Оставить один Cloudflare beacon request.
- Либо добавить корректный `crossorigin`, либо удалить отдельный preload.
- Оставить реальное выполнение скрипта `afterInteractive`.
- Проверить, что аналитика не потеряла события.

### P2 — уменьшить secondary images

- Отдавать achievement icons в реальном размере.
- Не загружать пять achievement images до появления секции.
- Отдавать portrait в размере 64–96 px.
- Добавить favicon с versioned URL и длительным immutable cache.

## 15. План подтверждения

Для финального сравнения следует сделать минимум **10 cold-прогонов на вариант**, отдельно mobile и desktop.

Контролировать:

- LCP p50/p75/p95;
- выбранный LCP URL и размер ответа;
- LCP load delay/load duration/render delay;
- FCP;
- API p75 и максимальный ответ;
- forced reflow и layout duration;
- CLS;
- число запросов и общий transfer.

Поскольку CrUX не содержит данных, для реальной оценки CWV нужен production RUM через `web-vitals`, с разделением по устройствам и типам соединения.

## 16. Ограничения

- Измерения относятся только к главной странице и анонимному состоянию.
- Slow 4G и 4× CPU — browser emulation, а не физический телефон.
- Fast 4G и Slow 4G не задают точный реальный bandwidth и RTT.
- Browser-context cold может сохранять DNS, TLS и browser-process cache.
- В каждом load-сценарии было три прогона; это диагностическая, не regression-выборка.
- Controlled interactions выполнены по одному разу и не заменяют field INP.
- Load-only CLS не описывает весь жизненный цикл страницы.
- CrUX/field data отсутствуют.
- Оценки savings Chrome не являются подтверждённым A/B-результатом.
- Без `Server-Timing` внутренняя причина 25.33 s API outlier не установлена.

## Итог

Сервер отвечает быстро; основная проблема — не обработка HTML. На mobile **6.11 из 6.89 s LCP** уходит на загрузку неоптимального hero-изображения. После его исправления следующими узкими местами станут приоритет LCP request, render-blocking CSS и client-side data waterfall. Измеренная интерактивность хорошая, CLS практически нулевой.

# Темп прогрессии и игровая форма: исправление

## Что считается точкой

Первый снимок аккаунта — базовый: он сохраняется, но не создаёт Tempo или Form.
Единый рейдовый интервал — это запись, для которой одновременно выполнено:

```text
status = valid
ΔPMC raids > 0
```

Только такой интервал получает обе оценки. Изменения только по Диким, неизменившиеся
снимки, reset и schema anomaly остаются в истории, но не получают score или
`score_sample_n`.

Оценка сравнивается с последним рейдовым интервалом каждого аккаунта в том же
диапазоне из 10 рейдов. Формулы не меняются:

- Tempo: XP/день — 55%, рейды ЧВК/день — 15%, убийства ЧВК/день — 15%, прочие убийства/день — 15%.
- Form: выживаемость — 25%, PvP K/D — 25%, AI K/D — 15%, убийства ЧВК/рейд — 25%, прочие убийства/рейд — 10%.

`score_sample_n` — размер текущей выборки аккаунтов в диапазоне. При `sampleN < 30`
точка остаётся видимой, но `preliminary=true`; её уверенность равна
`intervalConfidence × min(sampleN / 30, 1)`.

## API и график

Каждая точка содержит стабильный `pointId`, `observedAt`, `sampleN` и `preliminary`.
Для score-точек также передаются данные интервала (`periodStartAt`, `elapsedDays`,
`deltaExperience`, `deltaPmcRaids`) для tooltip. Линия игрока разделяется при смене
`seriesId`, поэтому reset не соединяется с предыдущей серией.

В `history` доступны:

- `allIntervalCount` — все интервалы;
- `changedIntervalCount` и обратный алиас `intervalCount` — изменившиеся валидные интервалы;
- `raidIntervalCount` — валидные интервалы с новой дельтой рейдов ЧВК;
- `tempoPointCount` и `formPointCount` — материализованные точки;
- `ready` — `true` после двух рейдовых интервалов.

## Материализация и кэш

После вставки нового снимка оператор, community helper и публичный профиль вызывают
один путь материализации затронутого 10-рейдового диапазона. Duplicate/stale снимки
его не запускают. Завершение operator-run выполняет полный пересчёт как страховку.

Успешная материализация атомарно увеличивает `progression_materializations.generation`.
Эта ревизия входит в ключ серверного кэша; namespace поднят до `v4`. Для Seasonal CDN
использует `s-maxage=60, stale-while-revalidate=30`, Regular остаётся `private, no-store`.

## Миграция и backfill

1. Сделать резервную копию SQLite/D1.
   Для D1 перед миграцией сохраните полный remote-export:

   ```text
   wrangler d1 export <database-name> --remote --output=./progression-before-backfill.sql
   ```

2. Для старого D1 применить один раз `scripts/seasonal-progression-revision-d1.sql`.
   Свежая схема уже содержит новые поля.
3. Для SQLite запустить:

   ```text
   npm run backfill:progression -- <path-to-progression.db> [active-season-cycle]
   ```

   Скрипт создаёт файл backup рядом с БД, выполняет идемпотентный полный пересчёт и
   останавливается, если рейдовые интервалы не получили обе оценки/`score_sample_n`
   или если нерейдовые интервалы сохранили score. Если второй аргумент не указан,
   берётся последняя включённая запись из `season_cycles`.
4. Для D1 после smoke-проверки вызвать операторский run до завершения: его финальный
   шаг использует тот же полный `refreshSeasonalDailyAggregates`.

5. Выполнить production smoke-check для SQLite:

   ```text
   npm run smoke:progression -- <path-to-progression.db> [active-season-cycle]
   ```

   Smoke-check проверяет `quick_check`, наличие совместимой схемы, отсутствие
   необработанных рейдовых интервалов/лишних score у нерейдовых интервалов и наличие
   ревизии materialization. Для D1 те же инварианты выполняются запросами ниже через
   `wrangler d1 execute <database-name> --remote`.

Проверить после запуска:

```sql
SELECT COUNT(*) AS bad_raid_intervals
FROM progression_intervals
WHERE status = 'valid' AND pmc_raids > 0
  AND (tempo_score IS NULL OR form_score IS NULL OR score_sample_n IS NULL);

SELECT COUNT(*) AS bad_non_raid_scores
FROM progression_intervals
WHERE (status <> 'valid' OR pmc_raids <= 0)
  AND (tempo_score IS NOT NULL OR form_score IS NOT NULL OR score_sample_n IS NOT NULL);
```

Оба значения должны быть равны нулю. В эксплуатации отслеживаются необработанные
рейдовые интервалы, задержка materialization и расхождение `generation` между
записью и публичным кэшем; первые значения доступны в `progression` ответа
`/api/operator/seasonal/status`.

D1 materialization выполняется одной `D1Database.batch()`-транзакцией: очистка,
пересчёт score, daily aggregates и увеличение generation либо применяются вместе,
либо откатываются целиком. Лимит batch учитывается при планировании размера
активной выборки (до 1 000 statements на free tier, до 10 000 на paid tier).

## Проверки

Профильные тесты покрывают baseline, Scav-only, одну рейдовую дельту, preliminary
sample, уникальность координат и reset-сегментацию, а также равенство
инкрементального и полного SQLite-пересчёта. Перед релизом выполняются:

```text
npm test
npm run i18n:check
npm run build
```

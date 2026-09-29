import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Регрессия #19: запись снимка PvE не должна синхронно задерживать ответ профиля.
// Маршрут обязан складывать persist в after(), а ошибку делать наблюдаемой.

test("pve snapshot write is queued after response and stays observable", async () => {
  const route = await readFile("app/api/player/profile/route.ts", "utf8");
  const pveStart = route.indexOf('if (mode === "pve") {');
  assert.ok(pveStart >= 0);
  const pveBranch = route.slice(pveStart);

  // Очередь после ответа, а не синхронное ожидание SQLite.
  assert.match(pveBranch, /after\(\(\) => persistRegularProfileSnapshot\(pveSnapshot,/);
  assert.doesNotMatch(pveBranch, /await persistRegularProfileSnapshot\(pveSnapshot/);
  // Тот же поток снимков: режим и уже открытый стор сохраняют дедупликацию.
  assert.match(pveBranch, /mode: "pve"/);
  assert.match(pveBranch, /playerStore: store/);
  // Ошибка фоновой записи наблюдаема.
  assert.match(pveBranch, /pve profile capture after response failed/);
  assert.match(pveBranch, /\.catch\(\(\s*error\s*\)\s*=>/);
  // Ответ несёт queued-статус, а не результат долгой записи.
  assert.match(pveBranch, /\{ inserted: false, status: "queued" \}/);
  // Защита от потери: без стора падаем явно, а не теряем снимок молча.
  assert.match(pveBranch, /if \(!store\) throw new Error\("player store unavailable"\)/);
  // Горячий путь больше не меряет store_write синхронно.
  assert.doesNotMatch(pveBranch, /storeWriteStarted/);
  assert.doesNotMatch(pveBranch, /storeWriteMs = timing\.elapsedMs/);
});

test("pve dedup and capture stream are unchanged", async () => {
  const [captureSource, progressionSource, route] = await Promise.all([
    readFile("lib/regular-profile-capture.ts", "utf8"),
    readFile("lib/progression-db.ts", "utf8"),
    readFile("app/api/player/profile/route.ts", "utf8"),
  ]);
  assert.match(captureSource, /captureSnapshot\(snapshot, mode\)/);
  assert.match(progressionSource, /status: "duplicate"/);
  assert.match(progressionSource, /status: "stale"/);
  // Тот же поток снимков для PvE: persist с mode "pve" остался в маршруте.
  assert.match(route, /persistRegularProfileSnapshot\(pveSnapshot/);
  assert.match(route, /mode: "pve"/);
});

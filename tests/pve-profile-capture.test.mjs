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

// Имитирует форму маршрута: ответ строится синхронно, persist уходит в after().
// Медленный endpoint (200 мс) не должен увеличивать время ответа на ту же величину.
test("slow persistence does not delay the queued pve response", async () => {
  const queued = [];
  const after = (task) => {
    const guarded = Promise.resolve().then(task);
    queued.push(guarded);
    return guarded;
  };
  let persistedSnapshot = null;
  const slowPersist = async (snapshot) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    persistedSnapshot = snapshot;
    return { inserted: true, status: "progression" };
  };

  const snapshot = { aid: 6657203, upstreamUpdatedAt: 1_700_000_000_000, capturedAt: Date.now() };
  const started = performance.now();
  // --- начало формы маршрута ---
  const capture = { inserted: false, status: "queued" };
  after(() => slowPersist(snapshot).catch((error) => {
    console.error("pve profile capture after response failed", error);
  }));
  const response = { capture, capturedAt: snapshot.capturedAt };
  // --- конец формы маршрута ---
  const responseMs = performance.now() - started;

  assert.deepEqual(response.capture, { inserted: false, status: "queued" });
  assert.equal(response.capturedAt, snapshot.capturedAt);
  assert.ok(responseMs < 100, `response took ${responseMs}ms, slow write leaked into it`);
  assert.equal(persistedSnapshot, null);

  await Promise.all(queued);
  assert.deepEqual(persistedSnapshot, snapshot);
});

// Ошибочный endpoint: ответ цел, ошибка попадает в логи, снимок не превращается в 503.
test("failing background persist keeps the response and logs the error", async () => {
  const queued = [];
  const after = (task) => {
    const guarded = Promise.resolve().then(task);
    queued.push(guarded);
    return guarded;
  };
  const failure = new Error("sqlite busy");
  const failingPersist = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw failure;
  };

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args);
  };
  try {
    const snapshot = { aid: 6657203, upstreamUpdatedAt: 1_700_000_000_001, capturedAt: Date.now() };
    // --- начало формы маршрута ---
    const capture = { inserted: false, status: "queued" };
    after(() => failingPersist(snapshot).catch((error) => {
      console.error("pve profile capture after response failed", error);
    }));
    const response = { capture };
    // --- конец формы маршрута ---
    assert.deepEqual(response.capture, { inserted: false, status: "queued" });

    await Promise.all(queued);
  } finally {
    console.error = originalError;
  }

  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /pve profile capture after response failed/);
  assert.equal(logged[0][1], failure);
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

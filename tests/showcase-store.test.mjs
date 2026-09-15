import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShowcaseStore, SHOWCASE_MAX_GROUPS, SHOWCASE_MAX_ITEMS } from "../lib/admin/showcase-db.ts";

function runInitializationProbe(source) {
  const directory = mkdtempSync(join(tmpdir(), "showcase-init-"));
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
      import { dirname } from "node:path";
      import { getShowcaseStore } from ${JSON.stringify(new URL("../lib/admin/showcase-db.ts", import.meta.url).href)};
      const errors = [];
      console.warn = (message) => errors.push(message);
      let now = Date.now();
      Date.now = () => now;
      ${source}
    `], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, ADMIN_ANALYTICS_SQLITE_PATH: join(directory, "nested", "showcase.db") },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("showcase retries a failed database open after cooldown and shares the recovered store", () => {
  runInitializationProbe(`
    const directory = dirname(process.env.ADMIN_ANALYTICS_SQLITE_PATH);
    writeFileSync(directory, "blocks mkdir");
    assert.equal(await getShowcaseStore(), null);
    unlinkSync(directory);
    mkdirSync(directory);
    assert.equal(await getShowcaseStore(), null);
    assert.equal(errors.length, 1, "requests during cooldown must not retry or repeat warnings");
    now += 30_000;
    const [first, second] = await Promise.all([getShowcaseStore(), getShowcaseStore()]);
    assert.ok(first, "opening must recover without restarting the process");
    assert.equal(first, second);
    const group = first.createGroup("Recovered");
    assert.equal((await getShowcaseStore()).listGroups()[0].id, group.id);
  `);
});

test("showcase closes a connection after SQLITE_FULL and recreates the schema on retry", () => {
  runInitializationProbe(`
    const exec = DatabaseSync.prototype.exec;
    let failedDb;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql.includes("CREATE TABLE") && !failedDb) {
        failedDb = this;
        exec.call(this, "PRAGMA max_page_count = 1");
      }
      return exec.call(this, sql);
    };
    assert.equal(await getShowcaseStore(), null);
    DatabaseSync.prototype.exec = exec;
    assert.match(errors[0], /database or disk is full/);
    assert.throws(() => failedDb.prepare("SELECT 1"), /not open|closed/i);
    now += 30_000;
    const store = await getShowcaseStore();
    assert.ok(store, "schema initialization must recover after SQLITE_FULL");
    const group = store.createGroup("After full disk");
    store.addItem(group.id, 101, "Player");
    assert.deepEqual(store.getActive().aids, [101]);
    const reader = new DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH, { readOnly: true });
    assert.equal(reader.prepare("SELECT name FROM home_showcase_groups WHERE id = ?").get(group.id).name, group.name);
    reader.close();
    assert.equal(errors.length, 1);
  `);
});

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = createShowcaseStore(db);
  const first = store.createGroup("First");
  const second = store.createGroup("Second");
  store.addItem(first.id, 101, "One");
  store.addItem(first.id, 202, "Two");
  return { db, store, first, second };
}

test("showcase CRUD preserves active selection, enabled items, order and deletion fallback", (t) => {
  const { store, first, second } = setup(t);
  store.renameGroup(second.id, "  Draft  ");
  assert.equal(store.listGroups()[1].name, "Draft");
  store.reorder(first.id, [202, 101]);
  assert.deepEqual(store.getActive().aids, [202, 101]);
  store.updateItem(first.id, 202, { enabled: false, nickname: "  Updated  " });
  assert.deepEqual(store.getActive().aids, [101]);
  assert.equal(store.listGroups()[0].items[0].nickname, "Updated");
  store.setActive(second.id);
  assert.equal(store.getActive().groupId, second.id);
  store.deleteGroup(second.id);
  assert.equal(store.getActive().groupId, first.id);
  store.removeItem(first.id, 101);
  assert.deepEqual(store.getActive().aids, []);
  store.deleteGroup(first.id);
  assert.deepEqual(store.listGroups(), []);
  assert.equal(store.getActive().groupId, null);
});

test("validation and group/item limits leave existing configuration intact", (t) => {
  const { store, first } = setup(t);
  const before = store.listGroups();
  for (const invalid of [() => store.setActive(999), () => store.addItem(first.id, -1),
    () => store.addItem(first.id, 101), () => store.renameGroup(first.id, " "),
    () => store.reorder(first.id, [101, 101]), () => store.reorder(first.id, [101]),
    () => store.updateItem(first.id, 101, { nickname: "x".repeat(65) })]) {
    assert.throws(invalid);
    assert.deepEqual(store.listGroups(), before);
  }
  for (let i = 2; i < SHOWCASE_MAX_GROUPS; i++) store.createGroup(`Group ${i}`);
  assert.throws(() => store.createGroup("Overflow"), /too many groups/);
  for (let i = 2; i < SHOWCASE_MAX_ITEMS; i++) store.addItem(first.id, 1000 + i);
  assert.throws(() => store.addItem(first.id, 9999), /group is full/);
});

test("failed activation rolls back the previous active group and allows retry", (t) => {
  const { db, store, second } = setup(t);
  const before = store.listGroups();
  db.exec(`CREATE TRIGGER fail_activation BEFORE UPDATE OF is_active ON home_showcase_groups
    WHEN NEW.id = ${second.id} AND NEW.is_active = 1
    BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END;`);
  assert.throws(() => store.setActive(second.id), /injected activation failure/);
  assert.deepEqual(store.listGroups(), before);
  db.exec("DROP TRIGGER fail_activation");
  store.setActive(second.id);
  assert.equal(store.getActive().groupId, second.id);
});

test("failed group deletion restores the group, its items and the active selection", (t) => {
  const { db, store, first } = setup(t);
  const before = store.listGroups();
  db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON home_showcase_groups
    BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END;`);
  assert.throws(() => store.deleteGroup(first.id), /injected deletion failure/);
  assert.deepEqual(store.listGroups(), before);
});

test("failed reorder rolls back earlier positions", (t) => {
  const { db, store, first } = setup(t);
  const before = store.listGroups();
  db.exec(`CREATE TRIGGER fail_order BEFORE UPDATE OF sort ON home_showcase_items
    WHEN NEW.aid = 101 BEGIN SELECT RAISE(ABORT, 'injected order failure'); END;`);
  assert.throws(() => store.reorder(first.id, [202, 101]), /injected order failure/);
  assert.deepEqual(store.listGroups(), before);
});

for (const action of ["add", "remove", "update"]) {
  test(`failed ${action} timestamp write rolls back item changes`, (t) => {
    const { db, store, first } = setup(t);
    const before = store.listGroups();
    db.exec(`CREATE TRIGGER fail_touch BEFORE UPDATE OF updated_at ON home_showcase_groups
      BEGIN SELECT RAISE(ABORT, 'injected timestamp failure'); END;`);
    const mutate = action === "add" ? () => store.addItem(first.id, 303)
      : action === "remove" ? () => store.removeItem(first.id, 101)
      : () => store.updateItem(first.id, 101, { nickname: "Changed", enabled: false });
    assert.throws(mutate, /injected timestamp failure/);
    assert.deepEqual(store.listGroups(), before);
  });
}

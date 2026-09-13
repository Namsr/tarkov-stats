import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createShowcaseStore, SHOWCASE_MAX_GROUPS, SHOWCASE_MAX_ITEMS } from "../lib/admin/showcase-db.ts";

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

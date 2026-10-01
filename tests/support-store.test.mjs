import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSupportStore, normalizeHref, SUPPORT_MAX_NOTIFICATIONS } from "../lib/admin/support-db.ts";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return { db, store: createSupportStore(db) };
}

test("a new notification is live and the active config lists it", (t) => {
  const { store } = setup(t);
  assert.deepEqual(store.getActive(), { notifications: [], goal: null });
  const notification = store.createNotification({ title: "  Scheduled downtime  ", body: "Tonight at 21:00 UTC.", level: "warn" });
  assert.equal(notification.title, "Scheduled downtime", "titles are trimmed");
  assert.equal(notification.isActive, true, "a new notice goes live without a second click");
  assert.deepEqual(store.getActive().notifications.map((item) => item.id), [notification.id]);
});

test("any number of notifications can stay live and each is switched on its own", (t) => {
  const { store } = setup(t);
  const first = store.createNotification({ title: "One", body: "First" });
  const second = store.createNotification({ title: "Two", body: "Second" });
  const third = store.createNotification({ title: "Three", body: "Third" });
  assert.deepEqual(store.getActive().notifications.map((item) => item.id), [first.id, second.id, third.id]);
  store.setNotificationActive(second.id, false);
  assert.deepEqual(store.getActive().notifications.map((item) => item.id), [first.id, third.id], "one row must not take the others with it");
  assert.equal(store.listNotifications().find((item) => item.id === second.id).isActive, false);
  store.setNotificationActive(second.id, true);
  assert.deepEqual(store.getActive().notifications.map((item) => item.id), [first.id, second.id, third.id]);
});

test("deleting a notification removes it from the active config", (t) => {
  const { store } = setup(t);
  const notification = store.createNotification({ title: "Gone", body: "Soon" });
  assert.deepEqual(store.deleteNotification(notification.id).map((item) => item.id), []);
  assert.deepEqual(store.getActive().notifications, []);
  assert.throws(() => store.deleteNotification(notification.id), /not found/);
});

test("updating a notification keeps its id, so a dismissed notice stays dismissed", (t) => {
  const { store } = setup(t);
  const notification = store.createNotification({ title: "Old text", body: "Old body", level: "info" });
  const updated = store.updateNotification(notification.id, { body: "New body", level: "danger" });
  assert.equal(updated.id, notification.id, "the id the visitor already stored must not change");
  assert.equal(updated.body, "New body");
  assert.equal(updated.level, "danger");
  assert.equal(updated.title, "Old text", "fields the patch omits are left alone");
});

test("notification links accept same-origin paths and https, and reject script schemes", (t) => {
  const { store } = setup(t);
  assert.equal(normalizeHref("/about"), "/about");
  assert.equal(normalizeHref("  https://example.com/x  "), "https://example.com/x");
  assert.equal(normalizeHref(""), null);
  assert.equal(normalizeHref(null), null);
  for (const hostile of ["javascript:alert(1)", "//evil.example", "/\\evil.example", "http://example.com", "data:text/html,<script>", "mailto:a@b.c"]) {
    assert.throws(() => normalizeHref(hostile), /invalid link|must be/, `must reject ${hostile}`);
  }
  assert.throws(
    () => store.createNotification({ title: "Bad", body: "Body", href: "javascript:alert(1)" }),
    /link must be a path or an https URL/,
  );
  assert.deepEqual(store.getActive().notifications, [], "a rejected link must not create a notice");
});

test("a notice requires both a title and a text, and the list is capped", (t) => {
  const { store } = setup(t);
  assert.throws(() => store.createNotification({ title: "  ", body: "Body" }), /title is required/);
  assert.throws(() => store.createNotification({ title: "Title", body: "" }), /body is required/);
  assert.throws(() => store.createNotification({ title: "x".repeat(121), body: "Body" }), /too long/);
  assert.throws(() => store.createNotification({ title: "Title", body: "Body", level: "critical" }), /invalid level/);
  for (let index = 0; index < SUPPORT_MAX_NOTIFICATIONS; index += 1) {
    store.createNotification({ title: `Notice ${index}`, body: "Body" });
  }
  assert.equal(store.listNotifications().length, SUPPORT_MAX_NOTIFICATIONS);
  assert.throws(() => store.createNotification({ title: "Overflow", body: "Body" }), /too many/);
});

test("the first fundraising goal goes live and later ones stay drafts", (t) => {
  const { store } = setup(t);
  const first = store.createGoal({ collectedRub: 4200, goalRub: 10000, usdRate: 95 });
  assert.equal(first.isActive, true);
  assert.equal(store.getActive().goal.collectedRub, 4200);
  const second = store.createGoal({ collectedRub: 0, goalRub: 5000, usdRate: 95 });
  assert.equal(second.isActive, false, "a second goal must not replace the live one silently");
  assert.equal(store.getActive().goal.id, first.id);
  store.setGoalActive(second.id);
  assert.equal(store.getActive().goal.id, second.id, "only the chosen goal is shown");
  assert.equal(store.getActive().goal.collectedRub, 0);
});

test("goal amounts must be non-negative, the target positive, and the rate above zero", (t) => {
  const { store } = setup(t);
  const goal = store.createGoal({ collectedRub: 100, goalRub: 1000, usdRate: 90 });
  assert.throws(() => store.createGoal({ collectedRub: -1, goalRub: 1000, usdRate: 90 }), /invalid collected/);
  assert.throws(() => store.createGoal({ collectedRub: 0, goalRub: 0, usdRate: 90 }), /goal must be positive/);
  assert.throws(() => store.createGoal({ collectedRub: 0, goalRub: 1000, usdRate: 0 }), /invalid rate/);
  assert.throws(() => store.updateGoal(goal.id, { collectedRub: -5 }), /invalid collected/);
  assert.throws(() => store.updateGoal(goal.id, { goalRub: 0 }), /goal must be positive/);
  assert.throws(() => store.updateGoal(goal.id, { goalRub: -1 }), /invalid goal/);
  assert.throws(() => store.updateGoal(goal.id, { usdRate: Number.NaN }), /invalid rate/);
  const updated = store.updateGoal(goal.id, { collectedRub: 750.4 });
  assert.equal(updated.collectedRub, 750, "amounts are whole rubles");
  assert.equal(updated.goalRub, 1000, "omitted fields are left alone");
});

test("the progress bar vanishes when no goal is active", (t) => {
  const { store } = setup(t);
  const goal = store.createGoal({ collectedRub: 0, goalRub: 1000, usdRate: 90 });
  store.createNotification({ title: "Note", body: "Body" });
  store.deleteGoal(goal.id);
  assert.equal(store.getActive().goal, null);
  assert.equal(store.getActive().notifications.length, 1, "notices are independent of the goal");
});

test("opening the schema on an existing database is safe and repeatable", (t) => {
  const { db } = setup(t);
  assert.doesNotThrow(() => {
    createSupportStore(db);
    createSupportStore(db);
  });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  assert.ok(names.includes("support_notifications"));
  assert.ok(names.includes("support_fundraising_goals"));
});

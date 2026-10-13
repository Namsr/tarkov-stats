import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSupportStore } from "../lib/admin/support-db.ts";
import { reportRepliesFromDb, userNotificationFeed } from "../lib/notifications.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = createSupportStore(db);
  db.exec(`ATTACH DATABASE ':memory:' AS admin_db;
    CREATE TABLE suspect_reports (user_sub TEXT, aid INTEGER, mode TEXT, cycle_id TEXT, created_at INTEGER, PRIMARY KEY(user_sub, aid));
    CREATE TABLE admin_db.admin_audit_log (id INTEGER PRIMARY KEY, aid INTEGER, action TEXT, next_status TEXT, detail TEXT, created_at INTEGER);
    INSERT INTO suspect_reports VALUES ('alice', 42, 'regular', 'persistent', 20), ('bob', 43, 'arena', 'persistent', 20);
    INSERT INTO admin_db.admin_audit_log VALUES
      (1, 42, 'review', 'reviewed', 'private note', 10),
      (2, 42, 'review', 'false_positive', 'private note', 30),
      (3, 43, 'review', 'confirmed', 'private note', 40),
      (4, 42, 'ban', 'confirmed', 'private reason', 50),
      (5, 42, 'restore', 'reviewed', 'private reason', 60);`);
  return { db, store };
}

test("report replies belong to their reporter, follow the report, and omit private moderation data", (t) => {
  const { db } = fixture(t);
  const replies = reportRepliesFromDb(db, "alice");
  assert.deepEqual(replies.map(({ id, status }) => [id, status]), [
    ["report:5", "restored"], ["report:4", "confirmed"], ["report:2", "false_positive"],
  ]);
  assert.equal(replies[0].href, "/player/regular/42");
  assert.doesNotMatch(JSON.stringify(replies), /private|alice|bob|detail|note/);
  assert.deepEqual(reportRepliesFromDb(db, "nobody"), []);
  assert.deepEqual(reportRepliesFromDb(db, "bob").map((item) => item.id), ["report:3"]);
  assert.equal(reportRepliesFromDb(db, "bob")[0].href, "/player/arena/43");
});

test("news and replies share a feed; read state persists per account and notice ID", (t) => {
  const { db, store } = fixture(t);
  const notice = store.createNotification({ title: "News", body: "New feature" });
  const ids = [`news:${notice.id}`, "report:5"];
  store.markNotificationsRead("alice", ids);
  store.markNotificationsRead("alice", ids);
  const reopened = createSupportStore(db);
  const feed = userNotificationFeed(reopened, "alice", reportRepliesFromDb(db, "alice"));
  assert.equal(feed[0].kind, "news");
  assert.deepEqual(feed.filter((item) => item.read).map((item) => item.id), ids);
  assert.equal(userNotificationFeed(reopened, "bob", reportRepliesFromDb(db, "bob")).filter((item) => item.read).length, 0);
  store.updateNotification(notice.id, { title: "Edited" });
  assert.equal(userNotificationFeed(store, "alice", [])[0].read, true);
  store.setNotificationActive(notice.id, false);
  assert.deepEqual(userNotificationFeed(store, "alice", []), []);
});

test("the report inbox is bounded and keeps distinct responses with equal timestamps", (t) => {
  const { db } = fixture(t);
  const insert = db.prepare("INSERT INTO admin_db.admin_audit_log VALUES (?, 42, 'review', 'reviewed', NULL, 100)");
  for (let id = 6; id <= 110; id++) insert.run(id);
  const replies = reportRepliesFromDb(db, "alice");
  assert.equal(replies.length, 100);
  assert.equal(replies[0].id, "report:110");
  assert.equal(new Set(replies.map((item) => item.id)).size, 100);
});

test("a fresh report database with no moderation history has an empty inbox", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("ATTACH DATABASE ':memory:' AS admin_db");
  assert.deepEqual(reportRepliesFromDb(db, "alice"), []);
});

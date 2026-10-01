import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The support block, the header dot and the admin form are client components with
// no DOM here, so this suite pins the contract that must not drift: the read route
// they call, the per-browser dismissal key, the pathname the dot clears on, and the
// dictionary entries both languages must keep.
test("the support block fetches the public route and renders nothing when it is empty", async () => {
  const [content, styles] = await Promise.all([
    readFile("components/SupportContent.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);
  assert.match(content, /fetch\("\/api\/support"/);
  assert.match(content, /if \(config\.notifications\.length === 0 && !config\.goal\) return null;/);
  assert.match(content, /config\.notifications\.length > 0 &&/, "an empty list must not leave an empty container");
  assert.match(styles, /\.support-content:empty \{ display: none; \}/);
  // Currency is chosen from the active language, not stored twice.
  assert.match(content, /const rubles = lang === "ru";/);
  assert.match(content, /collectedRub \/ goal\.usdRate/);
  assert.match(content, /"RUB" : "USD"/);
  assert.match(content, /Math\.min\(100, Math\.round\(/, "the bar must not overflow past its goal");
});

test("the header dot clears by pathname, once per browser, and only in the header", async () => {
  const [header, notice, footer, community, faq] = await Promise.all([
    readFile("components/SiteHeader.tsx", "utf8"),
    readFile("components/SupportHeaderNotice.tsx", "utf8"),
    readFile("components/SiteFooter.tsx", "utf8"),
    readFile("components/CommunityPage.tsx", "utf8"),
    readFile("components/FaqWidget.tsx", "utf8"),
  ]);
  assert.match(header, /useUnseenSupportNotifications\(pathname\)/);
  assert.match(header, /item\.support && unseenSupportIds\.length > 0/);
  assert.match(notice, /const SUPPORT_PATH = "\/support";/);
  assert.match(notice, /const onSupportPage = pathname === SUPPORT_PATH;/);
  assert.match(notice, /if \(onSupportPage && active\.length > 0\) \{\s*writeSeen\(active\);\s*setIds\(\[\]\);/, "reaching the page is what dismisses the dot");
  assert.match(notice, /tarkov-stats-support-notifications-seen/);
  assert.match(notice, /active\.filter\(\(id\) => !seen\.includes\(id\)\)/, "dismissal is keyed by notification id");
  // The agreed scope is the header only; these three carry the same link.
  for (const [name, source] of [["footer", footer], ["community page", community], ["faq widget", faq]]) {
    assert.doesNotMatch(source, /tactical-nav-link__dot/, `the ${name} must not grow a second dot`);
  }
});

test("the admin support form guards the mutation route and offers per-row switches", async () => {
  const [panel, route, dashboard, dictionary] = await Promise.all([
    readFile("components/AdminSupport.tsx", "utf8"),
    readFile("app/api/admin/support/route.ts", "utf8"),
    readFile("components/AdminDashboard.tsx", "utf8"),
    readFile("lib/i18n/dictionary.ts", "utf8"),
  ]);
  assert.match(panel, /fetch\("\/api\/admin\/support"/);
  assert.match(panel, /"Content-Type": "application\/json"/);
  for (const action of ["create_notification", "update_notification", "set_notification_active", "delete_notification", "create_goal", "update_goal", "set_goal_active", "delete_goal"]) {
    assert.match(route, new RegExp(`"${action}"`), `the ${action} action must be dispatched`);
    assert.match(panel, new RegExp(action), `the admin form must reach ${action}`);
  }
  assert.match(route, /rejectInvalidAdminMutation\(request\)/);
  assert.match(route, /requireAdmin\(\)/);
  assert.match(route, /export const runtime = "nodejs";/);
  // Notification links are operator input, so the store must re-check them server-side.
  assert.match(panel, /linkPlaceholder/);
  assert.match(route, /typeof body\.href !== "string"/);
  assert.match(dashboard, /"support"/);
  assert.match(dashboard, /getJson<\{ notifications: SupportNotification\[\]; goals: FundraisingGoal\[\]; available: boolean \}>\("\/api\/admin\/support", \{ signal: request\.signal \}\)/);
  // Mutations must refresh the dashboard state, or the list stays stale until a tab switch.
  assert.match(panel, /onChange\(\{/);
  assert.match(panel, /result\.notifications \?\? notifications/);
  assert.match(panel, /result\.goals \?\? goals/);
  assert.match(dashboard, /<AdminSupport/);
  assert.match(dashboard, /onChange=\{\(\{ notifications, goals \}\) => setSupport\(\{ notifications, goals, available: true \}\)\}/);
  // Both languages keep the same key set; the admin form reads computed level keys.
  for (const key of ["admin.support.notifications", "admin.support.goals", "admin.support.usdRate", "nav.supportUnread", "support.fundraisingCollected", "support.fundraisingReached"]) {
    const matches = dictionary.match(new RegExp(`"${key}":`, "g")) ?? [];
    assert.equal(matches.length, 2, `${key} must exist in both dictionaries`);
  }
  for (const level of ["info", "warn", "danger"]) {
    const matches = dictionary.match(new RegExp(`"admin\\.support\\.level\\.${level}":`, "g")) ?? [];
    assert.equal(matches.length, 2, `admin.support.level.${level} must exist in both dictionaries`);
  }
});

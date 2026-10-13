import type { SupportStore } from "./admin/support-db.ts";
import { appRouteMode, isGameMode } from "../types/seasonal.ts";

export type ReportReplyStatus = "reviewed" | "false_positive" | "confirmed" | "restored";

export interface UserNotification {
  id: string;
  kind: "news" | "report";
  title: string;
  body: string;
  href: string;
  createdAt: number;
  read: boolean;
  aid?: number;
  status?: ReportReplyStatus;
}

// Read the existing audit trail; do not run moderation migrations or expose
// operator notes, voter identities, or another user's reports in a public request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reportRepliesFromDb(db: any, userSub: string): UserNotification[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'suspect_reports'").get() ||
      !db.prepare("SELECT 1 FROM admin_db.sqlite_master WHERE name = 'admin_audit_log'").get()) return [];
  const rows = db.prepare(`SELECT a.id, a.aid, a.action, a.next_status, a.created_at, r.mode
    FROM suspect_reports r JOIN admin_db.admin_audit_log a ON a.aid = r.aid
    WHERE r.user_sub = ? AND a.created_at >= r.created_at
      AND (a.action = 'restore' OR a.next_status IN ('reviewed', 'false_positive', 'confirmed'))
    ORDER BY a.created_at DESC, a.id DESC LIMIT 100`).all(userSub) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: `report:${row.id}`,
    kind: "report",
    title: "",
    body: "",
    aid: Number(row.aid),
    status: row.action === "restore" ? "restored" : row.next_status as ReportReplyStatus,
    href: `/player/${appRouteMode(isGameMode(row.mode) ? row.mode : "regular")}/${row.aid}`,
    createdAt: Number(row.created_at),
    read: false,
  }));
}

export async function readReportReplies(userSub: string): Promise<UserNotification[]> {
  const reportsPath = process.env.REPORTS_SQLITE_PATH || "/data/community-reports.db";
  const adminPath = process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db";
  const fs = await import("node:fs");
  // A fresh installation has no reports or decisions yet.
  if (!fs.existsSync(reportsPath) || !fs.existsSync(adminPath)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite = await import("node:sqlite" as string) as any;
  const db = new sqlite.DatabaseSync(reportsPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 250;");
    db.prepare("ATTACH DATABASE ? AS admin_db").run(adminPath);
    db.exec("PRAGMA query_only = ON;");
    return reportRepliesFromDb(db, userSub);
  } finally {
    db.close();
  }
}

export function userNotificationFeed(store: SupportStore, userSub: string, replies: UserNotification[]): UserNotification[] {
  const news: UserNotification[] = store.getActive().notifications.map((item) => ({
    id: `news:${item.id}`, kind: "news", title: item.title, body: item.body,
    href: item.href || "/support", createdAt: item.createdAt, read: false,
  }));
  const feed = [...news, ...replies].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const read = new Set(store.readNotificationIds(userSub, feed.map((item) => item.id)));
  return feed.map((item) => ({ ...item, read: read.has(item.id) }));
}

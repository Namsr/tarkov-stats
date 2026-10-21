"use client";

import StatCard from "@/components/StatCard";
import { useI18n } from "@/lib/i18n/context";
import type { AuthSummary, VisitorEngagement } from "@/lib/admin/analytics-db";

export function GoogleAuthPanel({ auth }: { auth: AuthSummary }) {
  const { t, lang } = useI18n();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const date = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { timeZone: "UTC" });
  return <section className="data-panel admin-panel">
    <h2 className="section-heading">{t("admin.auth.heading")}</h2>
    <p className="admin-chart-description">{t("admin.auth.scope", { from: date(auth.fromDay), to: date(auth.toDay) })}</p>
    <div className="admin-metrics admin-metrics--small">
      <StatCard label={t("admin.auth.activeUsers")} value={number(auth.activeUsers)} hint={t("admin.auth.activeUsers.hint")} />
      <StatCard label={t("admin.auth.signInUsers")} value={number(auth.signInUsers)} hint={t("admin.auth.signInUsers.hint")} />
      <StatCard label={t("admin.auth.signIns")} value={number(auth.signIns)} hint={t("admin.auth.signIns.hint")} />
    </div>
    <p className="admin-chart-description">{t("admin.auth.explanation")}</p>
  </section>;
}

export function VisitorEngagementPanel({ engagement }: { engagement: VisitorEngagement | null }) {
  const { t, lang } = useI18n();
  if (!engagement) return <div className="admin-notice">{t("admin.warning.storage")}</div>;
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const returningShare = engagement.visitors ? engagement.returningVisitors / engagement.visitors : 0;
  return <section className="data-panel admin-panel">
    <h2 className="section-heading">{t("admin.engagement.heading")}</h2>
    <p className="admin-chart-description">{t("admin.engagement.description")}</p>
    <div className="admin-metrics admin-metrics--small">
      {(["visitors", "newVisitors", "returningVisitors", "repeatVisitors", "regularVisitors"] as const).map((key) =>
        <StatCard key={key} label={t("admin.engagement." + key)} value={number(engagement[key])} hint={t("admin.engagement." + key + ".hint")} />)}
      <StatCard label={t("admin.engagement.returningShare")} value={engagement.visitors ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(returningShare) : t("common.notAvailable")} hint={t("admin.engagement.returningShare.hint")} />
    </div>
    {engagement.visitors === 0 && <p className="admin-empty">{t("admin.own.empty")}</p>}
    <p className="admin-chart-description">{t("admin.engagement.note")}</p>
  </section>;
}

export function DevicePanel({ devices }: { devices: Array<{ key: string; visits: number; pageviews: number }> }) {
  const { t, lang } = useI18n();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const total = devices.reduce((sum, row) => sum + row.visits, 0);
  return <section className="data-panel admin-panel">
    <h2 className="section-heading">{t("admin.devices.heading")}</h2>
    <p className="admin-chart-description">{t("admin.devices.description")}</p>
    <div className="admin-metrics admin-metrics--small">
      {(["mobile", "tablet", "desktop", "unknown"] as const).map((key) => {
        const row = devices.find((device) => device.key === key);
        const visits = row?.visits ?? 0;
        const share = total ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(visits / total) : t("common.notAvailable");
        return <StatCard key={key} label={t("admin.devices." + key)} value={number(visits)} hint={t("admin.devices.detail", { share, pageviews: number(row?.pageviews ?? 0) })} />;
      })}
    </div>
    {!devices.length && <p className="admin-empty">{t("admin.empty")}</p>}
  </section>;
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { FundraisingGoal, SupportConfig } from "@/lib/admin/support-db";

const EMPTY: SupportConfig = { notifications: [], goal: null };
const CURRENCY_FORMATS = new Map<string, Intl.NumberFormat>();
function moneyFormat(locale: string, currency: string, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${locale}:${currency}:${maximumFractionDigits}`;
  const cached = CURRENCY_FORMATS.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits,
  });
  CURRENCY_FORMATS.set(key, created);
  return created;
}

/** Operator content for the support page: notification blocks, then the donation progress bar. */
export default function SupportContent() {
  const { t, lang } = useI18n();
  const [config, setConfig] = useState<SupportConfig>(EMPTY);

  useEffect(() => {
    const request = new AbortController();
    let current = true;
    void fetch("/api/support", { cache: "no-store", signal: request.signal })
      .then((response) => (response.ok ? (response.json() as Promise<SupportConfig>) : null))
      .then((body) => { if (current && body) setConfig(body); })
      // An unavailable or unreachable route leaves the block absent rather than broken.
      .catch(() => { if (current) setConfig(EMPTY); });
    return () => { current = false; request.abort(); };
  }, []);

  if (config.notifications.length === 0 && !config.goal) return null;

  return (
    <div className="support-content">
      {config.notifications.length > 0 && (
        <div className="support-notifications">
          {config.notifications.map((notification) => (
            <article key={notification.id} className={`support-notice support-notice--${notification.level}`}>
              <h2 className="support-notice__title">{notification.title}</h2>
              <p className="support-notice__body">{notification.body}</p>
              {notification.href && <NotificationLink href={notification.href} label={t("support.noticeLink")} />}
            </article>
          ))}
        </div>
      )}
      {config.goal && <DonationProgress goal={config.goal} lang={lang} t={t} />}
    </div>
  );
}

function NotificationLink({ href, label }: { href: string; label: string }) {
  const external = href.startsWith("https://");
  if (external) {
    return <a className="support-notice__link" href={href} target="_blank" rel="noopener noreferrer">{label}<span aria-hidden>↗</span></a>;
  }
  return <Link className="support-notice__link" href={href} prefetch={false}>{label}<span aria-hidden>→</span></Link>;
}

function DonationProgress({ goal, lang, t }: {
  goal: FundraisingGoal;
  lang: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  // Amounts are stored in rubles; the dollar view is derived from the operator's rate,
  // so one figure is entered per goal and both languages stay in sync.
  const rubles = lang === "ru";
  const value = rubles ? goal.collectedRub : goal.collectedRub / goal.usdRate;
  const target = rubles ? goal.goalRub : goal.goalRub / goal.usdRate;
  const format = moneyFormat(rubles ? "ru-RU" : "en-US", rubles ? "RUB" : "USD", rubles ? 0 : 2);
  const reached = target > 0 && goal.collectedRub >= goal.goalRub;
  const percent = target > 0 ? Math.min(100, Math.round((goal.collectedRub / goal.goalRub) * 100)) : 0;

  return (
    <section className="support-fundraising" aria-labelledby="support-fundraising-title">
      <div className="support-fundraising__head">
        <h2 id="support-fundraising-title" className="support-fundraising__title">{t("support.fundraisingTitle")}</h2>
        <p className="support-fundraising__figures">
          <span>{t("support.fundraisingCollected", { collected: format.format(value) })}</span>
          <span className="support-fundraising__target">{t("support.fundraisingGoal", { goal: format.format(target) })}</span>
        </p>
      </div>
      <div
        className="support-fundraising__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t("support.fundraisingProgress", { percent })}
      >
        <span className="support-fundraising__fill" style={{ inlineSize: `${percent}%` }} />
      </div>
      <p className="support-fundraising__status">
        {reached ? t("support.fundraisingReached") : t("support.fundraisingPercent", { percent })}
      </p>
    </section>
  );
}

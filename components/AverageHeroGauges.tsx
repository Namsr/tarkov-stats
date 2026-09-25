"use client";

import "@/components/arena-profile.css";
import { ArenaRing } from "@/components/ArenaCombatSummary";
import { useI18n } from "@/lib/i18n/context";

export interface AverageHeroRow {
  n: number;
  [metric: string]: number | null;
}

export default function AverageHeroGauges({
  averages,
  sampleN,
  statisticLabel,
}: {
  averages: AverageHeroRow | null;
  sampleN: number;
  statisticLabel: string;
}) {
  const { t, lang } = useI18n();
  const num = (value: number | null | undefined, digits = 1) =>
    value == null || !Number.isFinite(value)
      ? "—"
      : value.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const int = (value: number | null | undefined) =>
    value == null || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString(lang);
  const kd = averages?.kd_ratio ?? null;
  const survival = averages?.survival_rate ?? null;
  const kpr = averages?.kills_per_raid ?? null;
  return (
    <div>
      <div className="arena-combat-scope">
        <strong>{statisticLabel}</strong>
        <span>{t("average.basedOn", { n: sampleN.toLocaleString(lang) })}</span>
      </div>
      <div className="arena-combat-gauges">
        <article className="arena-combat-card">
          <h2>{t("metric.kd_ratio")}</h2>
          <ArenaRing value={kd} max={8} text={num(kd, 2)} unit="" label={t("metric.kd_ratio")} />
          <strong className="arena-combat-status">
            {t("metric.killed_pmc")}: {int(averages?.killed_pmc)}
          </strong>
          <p className="arena-combat-note">
            {t("metric.deaths")}: {int(averages?.deaths)}
          </p>
        </article>
        <article className="arena-combat-card">
          <h2>{t("metric.survival_rate")}</h2>
          <ArenaRing
            value={survival}
            max={100}
            text={survival == null ? "—" : `${num(survival)}%`}
            unit="%"
            label={t("metric.survival_rate")}
          />
          <strong className="arena-combat-status">
            {t("metric.total_raids")}: {int(averages?.total_raids)}
          </strong>
          <p className="arena-combat-note">{statisticLabel}</p>
        </article>
        <article className="arena-combat-card">
          <h2>{t("metric.kills_per_raid")}</h2>
          <ArenaRing value={kpr} max={5} text={num(kpr, 2)} unit="" label={t("metric.kills_per_raid")} />
          <strong className="arena-combat-status">
            {t("metric.total_kills")}: {int(averages?.total_kills)}
          </strong>
          <p className="arena-combat-note">
            {t("metric.level")}: {int(averages?.level)}
          </p>
        </article>
      </div>
    </div>
  );
}

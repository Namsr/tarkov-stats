"use client";

import "@/components/arena-profile.css";
import { arenaBarPositionFromRatio } from "@/components/arena-ui";
import { useI18n } from "@/lib/i18n/context";
import type { AverageHeroRow } from "@/components/AverageHeroGauges";

const ROWS = [
  { key: "kd_ratio", digits: 2, percent: false },
  { key: "survival_rate", digits: 1, percent: true },
  { key: "kills_per_raid", digits: 2, percent: false },
  { key: "total_raids", digits: 0, percent: false },
] as const;

export default function AverageSelectionCompare({
  selection,
  baseline,
  baselineN,
}: {
  selection: AverageHeroRow | null;
  baseline: AverageHeroRow | null;
  baselineN: number;
}) {
  const { t, lang } = useI18n();
  const format = (value: number | null | undefined, digits: number, percent = false) =>
    value == null || !Number.isFinite(value)
      ? t("common.notAvailable")
      : value.toLocaleString(lang, { maximumFractionDigits: digits }) + (percent ? "%" : "");
  return (
    <section className="mt-10" aria-label={t("average.selectionCompare")}>
      <h2 className="section-heading mb-3">{t("average.selectionCompare")}</h2>
      <div className="arena-comparison-bars">
        <div className="arena-bars-legend">
          <span>
            <i className="arena-bars-player-key" />
            {t("average.selection")}
          </span>
          <span>
            <i className="arena-bars-average-key" />
            {t("radar.series.average")}
          </span>
        </div>
        {ROWS.map((row) => {
          const a = selection?.[row.key] ?? null;
          const b = baseline?.[row.key] ?? null;
          const ratio = a != null && b != null && b > 0 ? a / b : null;
          const difference =
            a != null && b != null
              ? row.percent
                ? a - b
                : b > 0
                  ? (a / b - 1) * 100
                  : null
              : null;
          return (
            <div className="arena-comparison-row" key={row.key}>
              <div className="arena-comparison-row__heading">
                <div>
                  <h3>{t("metric." + row.key)}</h3>
                  <p>
                    {t("radar.series.average")}: {format(b, row.digits, row.percent)}
                  </p>
                </div>
                <div className="arena-comparison-row__value">
                  <strong>{format(a, row.digits, row.percent)}</strong>
                  {difference != null && (
                    <p>
                      {difference > 0 ? "+" : ""}
                      {format(difference, 1)}
                      {row.percent ? ` ${t("arena.combat.pp")}` : "%"} {t("arena.combat.vsAverage")}
                    </p>
                  )}
                </div>
              </div>
              <div
                className="arena-comparison-track"
                role="img"
                aria-label={`${t("metric." + row.key)}: ${format(a, row.digits, row.percent)}; ${t("radar.series.average")}: ${format(b, row.digits, row.percent)}`}
              >
                {(() => {
                  const width = arenaBarPositionFromRatio(ratio);
                  return width == null ? null : <span className="arena-comparison-fill" style={{ width: `${width}%` }} />;
                })()}
                {b != null && <span className="arena-comparison-average" aria-hidden="true" />}
              </div>
            </div>
          );
        })}
      </div>
      <p className="arena-combat-footnote">
        {t("average.basedOn", { n: baselineN.toLocaleString(lang) })}
      </p>
    </section>
  );
}

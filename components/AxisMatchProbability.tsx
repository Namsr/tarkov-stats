"use client";

import type { AxisMatch } from "@/lib/axis-history";
import { useI18n } from "@/lib/i18n/context";

export default function AxisMatchProbability({ match }: { match: AxisMatch }) {
  const { t, lang } = useI18n();
  const probability = match.winProbability;
  const percent = (value: number) => value.toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { style: "percent", maximumFractionDigits: 1 });
  const name = (index: number) => {
    const name = match.teams[index]?.name;
    return name && !/^Team [A-Z]$/.test(name) ? name : t("axis.history.team", { n: index === 0 ? "A" : "B" });
  };
  return <div className="axis-match-probability" role="group" aria-label={t("axis.prediction.label")}>
    <span className="axis-match-probability__label">{t("axis.prediction.label")}</span>
    {probability ? <>
      <span className="axis-match-probability__team" data-team="a">{name(0)} <strong>{percent(probability.a)}</strong></span>
      <span className="axis-match-probability__team" data-team="b">{name(1)} <strong>{percent(probability.b)}</strong></span>
      <span className="axis-match-probability__bar" aria-hidden="true"><span style={{ width: `${probability.a * 100}%` }} /></span>
    </> : <span className="axis-match-probability__empty">—</span>}
  </div>;
}

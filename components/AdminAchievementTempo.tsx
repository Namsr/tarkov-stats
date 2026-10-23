"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import type { TempoReport } from "@/lib/achievement-tempo-store";

export default function AdminAchievementTempo({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState("regular");
  const [input, setInput] = useState("");
  const [aid, setAid] = useState("");
  const [report, setReport] = useState<TempoReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let active = true;
    setLoading(true);
    setError(false);
    setReport(null);
    const params = new URLSearchParams({ mode });
    if (aid) params.set("aid", aid);
    void fetch(`/api/admin/achievement-tempo?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<TempoReport>;
      }).then((data) => { if (active) setReport(data); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [aid, mode, refreshKey, retry]);
  const number = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  const days = (value: number | null) => value === null ? t("common.notAvailable") : t("tempo.days", { n: number.format(value) });
  const date = (value: number | null) => value === null ? t("common.notAvailable")
    : new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }).format(value);
  function submit(event: FormEvent) {
    event.preventDefault();
    setAid(input.trim());
    setRetry((n) => n + 1);
  }
  function inspect(value: number) { setInput(String(value)); setAid(String(value)); }
  return <section className="admin-tempo" aria-labelledby="tempo-heading">
    <h2 id="tempo-heading">{t("tempo.heading")}</h2>
    <p className="admin-notice">{t("tempo.experimental")}</p>
    <p>{t("tempo.limits")}</p>
    <form className="admin-filters" onSubmit={submit}>
      <label><span>{t("admin.mode")}</span><select value={mode} onChange={(event) => setMode(event.target.value)}>
        <option value="regular">{t("admin.mode.regular")}</option><option value="seasonal">{t("admin.mode.seasonal")}</option>
      </select></label>
      <label><span>{t("tempo.account")}</span><input inputMode="numeric" pattern="[0-9]{1,15}" value={input}
        onChange={(event) => setInput(event.target.value)} placeholder={t("tempo.placeholder")} /></label>
      <button type="submit" className="admin-button">{t("tempo.inspect")}</button>
    </form>
    {loading && <p role="status">{t("common.loading")}</p>}
    {error && <div className="admin-notice admin-notice--error" role="alert">{t("admin.error.load")} <button type="button" onClick={() => setRetry((n) => n + 1)}>{t("admin.retry")}</button></div>}
    {!loading && !error && report && (!report.available ? <p role="status">{t("tempo.unavailable." + report.reason)}</p> : <>
      <p>{t("tempo.published", { date: date(report.generatedAt), n: number.format(report.profiles) })}</p>
      {report.stale && <p className="admin-notice" role="status">{t("tempo.stale")}</p>}
      <h3>{t("tempo.population")}</h3>
      <div className="admin-table-scroll" tabIndex={0} role="region" aria-label={t("tempo.population")}><table className="admin-table"><thead><tr>
        <th scope="col">{t("tempo.transition")}</th><th scope="col">{t("tempo.sample")}</th><th scope="col">{t("tempo.median")}</th>
        <th scope="col">{t("tempo.p5")}</th><th scope="col">{t("tempo.p1")}</th><th scope="col">{t("tempo.examples")}</th>
      </tr></thead><tbody>{report.cohorts.map((cohort) => <tr key={cohort.key}>
        <th scope="row">{t("tempo.transition." + cohort.key)}</th><td>{number.format(cohort.n)}</td><td>{days(cohort.median)}</td>
        <td>{days(cohort.p5)}</td><td>{days(cohort.p1)}</td><td>{cohort.examples.map((id) => <button type="button" key={id} onClick={() => inspect(id)}>{id}</button>)}</td>
      </tr>)}</tbody></table></div>
      <details><summary>{t("tempo.omitted")}</summary>{report.cohorts.map((cohort) => <div key={cohort.key}>
        <h4>{t("tempo.transition." + cohort.key)}</h4><ul>{Object.entries(cohort.omitted).map(([reason, n]) => <li key={reason}>{t("tempo.reason." + reason)}: {number.format(n!)}</li>)}</ul>
      </div>)}</details>
      {report.aid !== null && <>
        <h3>{t("tempo.player", { id: report.aid })}</h3>
        {report.observedAt === null ? <p role="status">{t("tempo.noProfile")}</p> : <>
          <p>{t("tempo.observed", { date: date(report.observedAt) })} <Link href={`/player/${mode === "regular" ? "regular" : "pvp-season"}/${report.aid}${mode === "seasonal" ? `?cycle=${encodeURIComponent(report.scope.cycleId)}` : ""}`}>{t("tempo.openProfile")}</Link></p>
          <p>{t("tempo.percentileHelp")}</p>
          <div className="admin-table-scroll" tabIndex={0} role="region" aria-label={t("tempo.player", { id: report.aid })}><table className="admin-table"><thead><tr>
            <th scope="col">{t("tempo.transition")}</th><th scope="col">{t("tempo.dates")}</th><th scope="col">{t("tempo.duration")}</th>
            <th scope="col">{t("tempo.sample")}</th><th scope="col">{t("tempo.median")}</th><th scope="col">{t("tempo.percentile")}</th><th scope="col">{t("tempo.result")}</th>
          </tr></thead><tbody>{report.evaluations.map((item) => <tr key={item.key}>
            <th scope="row">{t("tempo.transition." + item.key)}</th><td>{date(item.fromAt)}<br />{date(item.toAt)}</td><td>{days(item.days)}</td>
            <td>{number.format(item.n)}</td><td>{days(item.median)}</td><td>{item.percentile === null ? t("common.notAvailable") : `${number.format(item.percentile)}%`}</td>
            <td>{item.reason ? t("tempo.reason." + item.reason) : t("tempo.signal." + item.signal)}</td>
          </tr>)}</tbody></table></div>
          {report.strongest && <p>{t("tempo.strongest", { transition: t("tempo.transition." + report.strongest) })}</p>}
        </>}
      </>}
    </>)}
  </section>;
}

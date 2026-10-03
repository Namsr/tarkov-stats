"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { axisProfileHref, parseAxisProfile, type AxisLeagueResponse, type AxisPlayer } from "@/lib/axis-league";

export default function AdminAxisLeague({ data, onChange }: { data: AxisLeagueResponse | null; onChange: (data: AxisLeagueResponse) => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const players = (data?.players ?? []).filter((player) => `${player.name} ${player.id} ${player.profile?.aid ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="data-panel admin-panel" aria-label={t("axis.title")}>
    <div className="axis-heading"><h2 className="section-heading">{t("axis.title")}</h2><Link href="/axis-league" className="ghost-button">{t("axis.admin.open")}</Link></div>
    <p className="admin-chart-description">{t("axis.admin.description")}</p>
    {(data?.stale || !data?.available) && <p className="admin-notice" role="status">{t(data?.available ? "axis.stale" : "axis.error")}</p>}
    <div className="admin-moderation axis-admin-search"><label><span>{t("axis.search")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("axis.searchPlaceholder")} /></label></div>
    <p className="leaderboard-meta">{t("axis.results", { n: players.length })}</p>
    <ul className="axis-admin-players">{players.map((player) => <ProfileEditor key={`${player.id}:${player.profile?.mode ?? ""}:${player.profile?.aid ?? ""}`} player={player} onChange={onChange} />)}</ul>
    {data?.available && players.length === 0 && <p className="admin-empty">{t(data.players.length ? "axis.noResults" : "axis.empty")}</p>}
  </section>;
}

function ProfileEditor({ player, onChange }: { player: AxisPlayer; onChange: (data: AxisLeagueResponse) => void }) {
  const { t } = useI18n();
  const initial = player.profile ? axisProfileHref(player.profile) : "";
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(profile: string | null) {
    if (profile !== null && !parseAxisProfile(profile)) { setMessage(t("axis.admin.invalid")); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/axis-league", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ discordId: player.id, profile }) });
      const body = await response.json() as { ok?: boolean; data: AxisLeagueResponse };
      if (!response.ok || !body.ok) { setMessage(t(response.status === 400 ? "axis.admin.conflict" : "admin.error.save")); return; }
      onChange(body.data as AxisLeagueResponse);
      setMessage(t("axis.admin.saved"));
    } catch { setMessage(t("admin.error.save")); }
    finally { setBusy(false); }
  }
  return <li className="axis-admin-player">
    <div className="axis-admin-identity"><strong>{player.name}</strong><span className="admin-badge">#{player.position}</span><small>{t("axis.admin.discordId", { id: player.id })}</small>
      {player.profile ? <Link className="admin-account__profile-link" href={axisProfileHref(player.profile)} prefetch={false}>{t("admin.showcase.openProfile")}</Link> : <span className="admin-badge">{t("axis.admin.unlinked")}</span>}
    </div>
    <form className="admin-moderation" onSubmit={(event) => { event.preventDefault(); void save(draft.trim()); }}>
      <label><span>{t("axis.admin.profileFor", { name: player.name })}</span><input value={draft} disabled={busy} maxLength={400} onChange={(event) => { setDraft(event.target.value); setMessage(""); }} placeholder={t("axis.admin.placeholder")} /></label>
      <button type="submit" className="ghost-button" disabled={busy || !draft.trim() || draft.trim() === initial}>{t("axis.admin.save")}</button>
      {player.profile && <button type="button" className="ghost-button admin-danger" disabled={busy} onClick={() => void save(null)}>{t("axis.admin.remove")}</button>}
    </form>
    {message && <p className="admin-notice" role="status">{message}</p>}
  </li>;
}

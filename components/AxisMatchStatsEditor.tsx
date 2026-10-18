"use client";

import { useRef, useState, type ReactNode } from "react";
import AxisMatchPhoto, { type AxisMatchPhotoHandle } from "@/components/AxisMatchPhoto";
import { useI18n } from "@/lib/i18n/context";
import { sortAxisMatchPlayers, type AxisMatch } from "@/lib/axis-history";
import { AXIS_KDA_MAX, parseAxisKda, sameAxisKda, parseAxisRoundScore, sameAxisRoundScore, type AxisRoundScore, type AxisRoundChange, type AxisKda, type AxisKdaChange } from "@/lib/axis-kda";

const fields = ["kills", "deaths", "assists"] as const;
type Draft = { discordId: string; expected: AxisKda | null; kills: string; deaths: string; assists: string };
type RoundDraft = { a: string; b: string; expected: AxisRoundScore | null };

export default function AxisMatchStatsEditor({ match, canEdit, children, onSaved, onConflict }: {
  match: AxisMatch;
  canEdit: boolean;
  children: (state: { teams: AxisMatch["teams"]; renderInputs: (id: string) => ReactNode; rounds: ReactNode; editing: boolean }) => ReactNode;
  onSaved: (players: { discordId: string; kda: AxisKda | null }[], rounds?: AxisRoundScore | null) => void;
  onConflict: () => void;
}) {
  const { t, lang } = useI18n();
  const photo = useRef<AxisMatchPhotoHandle>(null);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [roundDraft, setRoundDraft] = useState<RoundDraft | null>(null);
  const [roster, setRoster] = useState<AxisMatch["teams"]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const players = match.teams.flatMap((team) => team.players);
  const hasStats = players.some((player) => player.kda != null) || match.rounds != null;
  const teams = draft === null ? match.teams.map((team) => ({ ...team, players: sortAxisMatchPlayers(team.players, lang) })) : roster;
  function teamName(index: number) {
    const name = teams[index].name;
    return name && !/^Team [A-Z]$/.test(name) ? name : t("axis.history.team", { n: String.fromCharCode(65 + index) });
  }
  function begin() {
    setMessage(""); setRoster(teams);
    setDraft(players.map((player) => ({ discordId: player.id, expected: player.kda ?? null,
      kills: player.kda == null ? "" : String(player.kda.kills), deaths: player.kda == null ? "" : String(player.kda.deaths), assists: player.kda == null ? "" : String(player.kda.assists) })));
    setRoundDraft({ a: match.rounds == null ? "" : String(match.rounds.a), b: match.rounds == null ? "" : String(match.rounds.b), expected: match.rounds ?? null });
  }
  async function save() {
    let changes: AxisKdaChange[];
    let rounds: AxisRoundChange | undefined;
    try {
      changes = (draft ?? []).map((row) => {
        const empty = fields.every((field) => row[field] === "");
        if (!empty && fields.some((field) => !/^\d{1,4}$/.test(row[field]))) throw new TypeError("Incomplete KDA");
        return { discordId: row.discordId, expected: row.expected,
          kda: empty ? null : parseAxisKda({ kills: Number(row.kills), deaths: Number(row.deaths), assists: Number(row.assists) }) };
      }).filter((row) => !sameAxisKda(row.kda, row.expected));
      if (roundDraft && teams.length === 2) {
        const empty = roundDraft.a === "" && roundDraft.b === "";
        if (!empty && ![roundDraft.a, roundDraft.b].every((value) => /^\d{1,4}$/.test(value))) throw new TypeError("Incomplete score");
        const score = empty ? null : parseAxisRoundScore({ a: Number(roundDraft.a), b: Number(roundDraft.b) });
        if (!sameAxisRoundScore(score, roundDraft.expected)) rounds = { score, expected: roundDraft.expected };
      }
    } catch { setMessage(t("axis.kda.invalid")); return; }
    const photoChange = photo.current?.getChange();
    if (photoChange === false) return;
    if (!changes.length && rounds === undefined && photoChange === undefined) { setDraft(null); setRoundDraft(null); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/axis-league/match-stats", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchNumber: match.number, players: changes, rounds, photo: photoChange }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok || !body.ok || body.matchNumber !== match.number || !Array.isArray(body.players)) {
        if (response.status === 409) { if (photoChange !== undefined) photo.current?.conflict(); onConflict(); setMessage(t("axis.kda.conflict")); }
        else setMessage(t(response.status === 413 ? "axis.photo.tooLarge" : "admin.error.save"));
        return;
      }
      onSaved(body.players, body.rounds);
      setDraft(null); setRoundDraft(null); setMessage(t("admin.saved"));
    } catch { setMessage(t("admin.error.save")); }
    finally { setBusy(false); }
  }
  function renderInputs(id: string) {
    const row = draft?.find((entry) => entry.discordId === id);
    if (!row || !canEdit) return null;
    const name = roster.flatMap((team) => team.players).find((player) => player.id === id)?.name ?? id;
    return <div className="axis-kda-inline">
      {fields.map((field) => <label key={field} title={t("arena.counter." + field)}><span>{t("axis.kda.column." + field)}</span>
        <input type="number" inputMode="numeric" min={0} max={AXIS_KDA_MAX} step={1} disabled={busy} value={row[field]}
          aria-label={t("axis.kda.input", { name, metric: t("arena.counter." + field) })}
          onChange={(event) => { setMessage(""); setDraft((rows) => rows?.map((entry) => entry.discordId === id ? { ...entry, [field]: event.target.value } : entry) ?? null); }} />
      </label>)}
      <button type="button" className="axis-kda-clear" disabled={busy} title={t("axis.kda.clear")} aria-label={t("axis.kda.clearPlayer", { name })}
        onClick={() => { setMessage(""); setDraft((rows) => rows?.map((entry) => entry.discordId === id ? { ...entry, kills: "", deaths: "", assists: "" } : entry) ?? null); }}><span aria-hidden="true">×</span></button>
    </div>;
  }
  const rounds = teams.length === 2 ? <div className="axis-match-rounds">
    <span className="axis-match-rounds__label">{t("axis.rounds.label")}</span>
    {canEdit && draft !== null && roundDraft ? <div className="axis-round-inputs">
      {(["a", "b"] as const).map((side, index) => <label key={side}>
        <span>{teamName(index)}</span>
        <input type="number" inputMode="numeric" min={0} max={AXIS_KDA_MAX} step={1} disabled={busy} value={roundDraft[side]}
          aria-label={t("axis.rounds.input", { team: teamName(index) })}
          onChange={(event) => { setMessage(""); setRoundDraft((previous) => previous ? { ...previous, [side]: event.target.value } : previous); }} />
      </label>)}
      <button type="button" className="axis-kda-clear" disabled={busy} aria-label={t("axis.rounds.clear")} onClick={() => { setMessage(""); setRoundDraft((previous) => previous ? { ...previous, a: "", b: "" } : previous); }}><span aria-hidden="true">×</span></button>
    </div> : <strong>{match.rounds ? `${match.rounds.a} : ${match.rounds.b}` : "— : —"}</strong>}
  </div> : null;
  const content = children({ teams, renderInputs, rounds, editing: canEdit && draft !== null });
  if (!canEdit) return content;
  return <form className="axis-match-edit-form" onPaste={(event) => photo.current?.paste(event)} onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={t("axis.kda.form", { n: match.number })}>
    {content}
    {draft !== null && <AxisMatchPhoto ref={photo} matchNumber={match.number} busy={busy} />}
    {(players.length > 0 || teams.length === 2) && <div className="axis-kda-editor">
      {draft === null ? <button type="button" className="ghost-button" onClick={begin}>{t(hasStats ? "axis.kda.edit" : "axis.kda.add")}</button> : <>
        <p className="axis-kda-hint">{t("axis.kda.hint")}</p>
        <div className="axis-kda-actions"><button type="submit" className="tactical-button" disabled={busy}>{t(busy ? "common.loading" : "axis.kda.save")}</button>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => { setDraft(null); setRoundDraft(null); setMessage(""); }}>{t("axis.kda.cancel")}</button></div>
      </>}
      {message && <p className="admin-notice" role="status">{message}</p>}
    </div>}
  </form>;
}

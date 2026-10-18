"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useI18n } from "@/lib/i18n/context";
import { inferAxisOcrLeftTeam, matchAxisOcrRows, parseAxisOcrCounter, type AxisOcrContext, type AxisOcrCrop, type AxisOcrImage, type AxisOcrParticipant, type AxisOcrResult } from "@/lib/axis-ocr";
import type { AxisOcrKdaCandidate, AxisOcrRoundCandidate, AxisOcrTouchSnapshot } from "@/lib/axis-ocr-draft";
import { analyzeAxisOcrMappingSafety } from "@/lib/axis-ocr-mapping";

export interface AxisOcrPreviewHandle {
  invalidate: () => void;
}
type PreviewState = {
  status: "idle" | "running" | "ready" | "error";
  progress: number;
  result: AxisOcrResult | null;
  context: AxisOcrContext | null;
  assignments: Record<string, string | null>;
  started: AxisOcrTouchSnapshot;
  fillMessage: string;
};
type CropDraft = { x: string; y: string; width: string; height: string };
type LeftTeamChoice = "unknown" | "0" | "1";
type Props = {
  ref: Ref<AxisOcrPreviewHandle>;
  image: AxisOcrImage;
  matchNumber: number;
  sessionKey: number;
  busy: boolean;
  teamNames: string[];
  onJobStart: () => AxisOcrTouchSnapshot;
  onFill: (kda: AxisOcrKdaCandidate[], rounds: AxisOcrRoundCandidate | null, started: AxisOcrTouchSnapshot) => number;
};

function isContext(value: unknown, matchNumber: number): value is AxisOcrContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<AxisOcrContext>;
  return context.matchNumber === matchNumber && Array.isArray(context.participants)
    && context.participants.length === 10
    && context.participants.every((participant: AxisOcrParticipant) => participant
      && typeof participant.discordId === "string"
      && (participant.teamIndex === 0 || participant.teamIndex === 1)
      && typeof participant.historyName === "string"
      && (participant.arenaNickname === null || typeof participant.arenaNickname === "string"));
}

function cropFromDraft(draft: CropDraft, image: AxisOcrImage): { crop?: AxisOcrCrop; invalid: boolean } {
  const values = [draft.x, draft.y, draft.width, draft.height];
  if (values.every((value) => value === "")) return { invalid: false };
  if (!values.every((value) => /^\d+$/.test(value))) return { invalid: true };
  const [x, y, width, height] = values.map(Number);
  if (![x, y, width, height].every(Number.isSafeInteger)
    || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > image.width || y + height > image.height) return { invalid: true };
  return { crop: { x, y, width, height }, invalid: false };
}

function initialState(): PreviewState {
  return { status: "idle", progress: 0, result: null, context: null, assignments: {}, started: {}, fillMessage: "" };
}

export default function AxisOcrPreview({
  ref, image, matchNumber, sessionKey, busy, teamNames, onJobStart, onFill,
}: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<PreviewState>(initialState);
  const [cropDraft, setCropDraft] = useState<CropDraft>({ x: "", y: "", width: "", height: "" });
  const [cropError, setCropError] = useState(false);
  const [leftTeamChoice, setLeftTeamChoice] = useState<LeftTeamChoice>("unknown");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const jobStartRef = useRef(onJobStart);
  const fillRef = useRef(onFill);
  useEffect(() => {
    jobStartRef.current = onJobStart;
    fillRef.current = onFill;
  }, [onJobStart, onFill]);

  const abortRecognition = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
  }, []);
  const invalidate = useCallback(() => {
    abortRecognition();
    setState(initialState());
    setLeftTeamChoice("unknown");
  }, [abortRecognition]);
  useImperativeHandle(ref, () => ({ invalidate }), [invalidate]);

  const runRecognition = useCallback(async (crop?: AxisOcrCrop) => {
    const id = ++generation.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLeftTeamChoice("unknown");
    const started = jobStartRef.current();
    setState({ ...initialState(), status: "running", started });

    try {
      const contextRequest = fetch(`/api/admin/axis-league/ocr-context?match=${matchNumber}`, {
        cache: "no-store",
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(15_000)]),
      });
      const engineRequest = import("@/lib/client-axis-ocr");
      const [response, engine] = await Promise.all([contextRequest, engineRequest]);
      if (!response.ok) throw new Error("OCR context unavailable");
      const contextValue: unknown = await response.json();
      if (!isContext(contextValue, matchNumber)) throw new Error("Invalid OCR context");
      const result = await engine.recognizeAxisScreenshot(image, {
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(120_000)]),
        ...(crop ? { crop } : {}),
        onProgress: (value) => {
          if (id !== generation.current || active.signal.aborted) return;
          const progress = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
          setState((previous) => previous.status === "running" ? { ...previous, progress } : previous);
        },
      });
      if (id !== generation.current || active.signal.aborted) return;
      const assignments = matchAxisOcrRows(result.rows, contextValue.participants);
      setState({ status: "ready", progress: 1, result, context: contextValue, assignments, started, fillMessage: "" });
    } catch {
      if (id !== generation.current || active.signal.aborted) return;
      setState({ ...initialState(), status: "error" });
    } finally {
      if (id === generation.current) controller.current = null;
    }
  }, [image, matchNumber]);

  useEffect(() => {
    setCropDraft({ x: "", y: "", width: "", height: "" });
    setCropError(false);
    setLeftTeamChoice("unknown");
    if (image.isNew) void runRecognition();
    return abortRecognition;
  }, [image.key, image.isNew, matchNumber, sessionKey, runRecognition, abortRecognition]);

  const result = state.result;
  const context = state.context;
  const mappingSafety = result && context
    ? analyzeAxisOcrMappingSafety(result.rows, state.assignments, context.participants)
    : null;
  const inferredLeftTeam = result && context && mappingSafety
    ? inferAxisOcrLeftTeam(result.rows, mappingSafety.safeAssignments, context.participants)
    : null;
  const manualLeftTeam = leftTeamChoice === "unknown" ? null : Number(leftTeamChoice) as 0 | 1;
  const leftTeam = inferredLeftTeam
    ?? (mappingSafety?.manualOrientationAllowed ? manualLeftTeam : null);

  const kdaCandidates: AxisOcrKdaCandidate[] = [];
  if (result) {
    for (const row of result.rows) {
      const discordId = state.assignments[row.id];
      if (!discordId || mappingSafety?.duplicateIds.has(discordId) || mappingSafety?.blockedKdaSides.has(row.side)) continue;
      kdaCandidates.push({
        discordId,
        kills: parseAxisOcrCounter(row.kills),
        deaths: parseAxisOcrCounter(row.deaths),
        assists: parseAxisOcrCounter(row.assists),
      });
    }
  }
  let roundCandidate: AxisOcrRoundCandidate | null = null;
  if (result && leftTeam !== null) {
    const left = parseAxisOcrCounter(result.score.left);
    const right = parseAxisOcrCounter(result.score.right);
    roundCandidate = leftTeam === 0 ? { a: left, b: right } : { a: right, b: left };
  }

  function requestRecognition() {
    const parsed = cropFromDraft(cropDraft, image);
    setCropError(parsed.invalid);
    if (parsed.invalid || busy || state.status === "running") return;
    void runRecognition(parsed.crop);
  }

  function fillEmpty() {
    if (!result) return;
    const filled = fillRef.current(kdaCandidates, roundCandidate, state.started);
    setState((previous) => previous.status === "ready"
      ? { ...previous, fillMessage: t(filled ? "axis.ocr.filled" : "axis.ocr.nothingFilled", filled ? { n: filled } : undefined) }
      : previous);
  }

  const cropFields = [
    ["x", t("axis.ocr.cropX"), image.width],
    ["y", t("axis.ocr.cropY"), image.height],
    ["width", t("axis.ocr.cropWidth"), image.width],
    ["height", t("axis.ocr.cropHeight"), image.height],
  ] as const;

  return <section className="axis-ocr-panel" aria-label={t("axis.ocr.heading")}>
    <div className="axis-ocr-panel__heading">
      <h4>{t("axis.ocr.heading")}</h4>
      <button type="button" className="ghost-button" disabled={busy || state.status === "running"} onClick={requestRecognition}>
        {t(state.status === "idle" ? "axis.ocr.recognize" : "axis.ocr.recognizeAgain")}
      </button>
      {state.status === "running" && <button type="button" className="ghost-button" onClick={invalidate}>{t("axis.ocr.cancel")}</button>}
    </div>
    <p className="axis-ocr-panel__crop-hint">{t("axis.ocr.cropHelp", { width: image.width, height: image.height })}</p>
    <div className="axis-ocr-crop" role="group" aria-label={t("axis.ocr.cropHelp", { width: image.width, height: image.height })}>
      {cropFields.map(([field, label, max]) => <label key={field}>
        <span>{label}</span>
        <input type="number" inputMode="numeric" min={field === "width" || field === "height" ? 1 : 0} max={max}
          value={cropDraft[field]} disabled={busy || state.status === "running"}
          onChange={(event) => { invalidate(); setCropError(false); setCropDraft((previous) => ({ ...previous, [field]: event.target.value })); }} />
      </label>)}
    </div>
    {cropError && <p className="admin-notice admin-notice--error" role="alert">{t("axis.ocr.cropInvalid")}</p>}
    {state.status === "running" && <div className="axis-ocr-progress" role="status" aria-live="polite">
      <span>{t("axis.ocr.running", { percent: Math.round(state.progress * 100) })}</span>
      <progress max={1} value={state.progress} aria-label={t("axis.ocr.progress")} />
    </div>}
    {state.status === "error" && <p className="admin-notice admin-notice--error" role="alert">{t("axis.ocr.error")}</p>}
    {result && context && <>
      <p className="sr-only" role="status" aria-live="polite">{t("axis.ocr.ready")}</p>
      <div className="axis-ocr-score">
        <strong>{t("axis.ocr.score")}: {result.score.left ?? "—"} : {result.score.right ?? "—"}</strong>
        {leftTeam === null
          ? <span>{t("axis.ocr.scoreUnmapped")}</span>
          : <span>{inferredLeftTeam === null
            ? t("axis.ocr.leftTeamManual", { team: teamNames[leftTeam] ?? t("axis.history.team", { n: String.fromCharCode(65 + leftTeam) }) })
            : t("axis.ocr.leftTeam", { team: teamNames[leftTeam] ?? t("axis.history.team", { n: String.fromCharCode(65 + leftTeam) }) })}</span>}
      </div>
      <label className="axis-ocr-left-team">
        <span>{t("axis.ocr.leftTeamSelect")}</span>
        <select value={inferredLeftTeam === null ? leftTeamChoice : String(inferredLeftTeam)} disabled={busy || inferredLeftTeam !== null || !mappingSafety?.manualOrientationAllowed}
          onChange={(event) => setLeftTeamChoice(event.target.value as LeftTeamChoice)}>
          <option value="unknown">{t("axis.ocr.leftTeamUnknown")}</option>
          {[0, 1].map((teamIndex) => <option key={teamIndex} value={String(teamIndex)}>
            {teamNames[teamIndex] ?? t("axis.history.team", { n: String.fromCharCode(65 + teamIndex) })}
          </option>)}
        </select>
      </label>
      {inferredLeftTeam === null && mappingSafety && !mappingSafety.manualOrientationAllowed
        && <p className="axis-ocr-row__warning" role="status">{t("axis.ocr.leftTeamBlocked")}</p>}
      {(mappingSafety && (mappingSafety.duplicateIds.size > 0 || mappingSafety.mixedSides.size > 0 || mappingSafety.sameTeamBothSides))
        && <p className="admin-notice admin-notice--error" role="status">{t("axis.ocr.mappingWarning")}</p>}
      {result.rows.length === 0
        ? <p className="axis-ocr-empty">{t("axis.ocr.empty")}</p>
        : <div className="axis-ocr-rows" role="list" aria-label={t("axis.ocr.previewRows")}>
          {result.rows.map((row) => {
            const assignedId = state.assignments[row.id] ?? "";
            const player = context.participants.find((participant) => participant.discordId === assignedId);
            const blocked = Boolean(assignedId && mappingSafety?.duplicateIds.has(assignedId))
              || Boolean(mappingSafety?.blockedKdaSides.has(row.side));
            return <article className="axis-ocr-row" role="listitem" key={row.id}>
              <div className="axis-ocr-row__name">
                <strong>{row.nickname || "—"}</strong>
                <span>{t(row.side === "left" ? "axis.ocr.sideLeft" : "axis.ocr.sideRight")}</span>
              </div>
              <label className="axis-ocr-row__assignment">
                <span>{t("axis.ocr.assign", { nickname: row.nickname || "—" })}</span>
                <select value={assignedId} disabled={busy} onChange={(event) => {
                  setLeftTeamChoice("unknown");
                  setState((previous) => ({
                    ...previous,
                    assignments: { ...previous.assignments, [row.id]: event.target.value || null },
                    fillMessage: "",
                  }));
                }}>
                  <option value="">{t("axis.ocr.unassigned")}</option>
                  {[0, 1].map((teamIndex) => {
                    const members = context.participants.filter((participant) => participant.teamIndex === teamIndex);
                    return <optgroup key={teamIndex} label={teamNames[teamIndex] ?? t("axis.history.team", { n: String.fromCharCode(65 + teamIndex) })}>
                      {members.map((participant) => <option key={participant.discordId} value={participant.discordId}>
                        {participant.historyName}{participant.arenaNickname && participant.arenaNickname !== participant.historyName ? ` · ${participant.arenaNickname}` : ""}
                      </option>)}
                    </optgroup>;
                  })}
                </select>
              </label>
              <div className="axis-ocr-row__stats" aria-label={t("axis.kda.short")}>
                <span>{t("axis.kda.column.kills")}: {row.kills ?? "—"}</span>
                <span>{t("axis.kda.column.deaths")}: {row.deaths ?? "—"}</span>
                <span>{t("axis.kda.column.assists")}: {row.assists ?? "—"}</span>
              </div>
              {blocked && <p className="axis-ocr-row__warning">{t("axis.ocr.mappingWarning")}</p>}
              {player && <small className="axis-ocr-row__team">{teamNames[player.teamIndex] ?? t("axis.history.team", { n: String.fromCharCode(65 + player.teamIndex) })}</small>}
            </article>;
          })}
        </div>}
      <button type="button" className="ghost-button axis-ocr-fill" disabled={busy} onClick={fillEmpty}>{t("axis.ocr.fillEmpty")}</button>
      {state.fillMessage && <p className="admin-notice" role="status">{state.fillMessage}</p>}
      <p className="axis-ocr-panel__note">{t("axis.ocr.provisional")}</p>
    </>}
  </section>;
}

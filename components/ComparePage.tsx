"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CompareProgressionSection from "@/components/CompareProgressionSection";
import ComparisonDossiers from "@/components/ComparisonDossiers";
import ProfilePortrait from "@/components/ProfilePortrait";
import ProfilePrestige from "@/components/ProfilePrestige";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import SearchBar from "@/components/SearchBar";
import SegmentedRadio from "@/components/SegmentedRadio";
import {
  adaptComparisonCohort,
  adaptComparisonProfile,
  comparisonCohortRequestUrl,
  comparisonProfileRequestUrl,
  comparisonScopeFromSearchParams,
} from "@/lib/comparison-adapter";
import { loadAverageJson } from "@/lib/client-average-request";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import { comparisonDossier } from "@/lib/comparison-dossier";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaComparisonScope, ComparisonCohort, ComparisonProfile, ComparisonScope, PersistentComparisonScope } from "@/types/comparison";
import { appRouteMode, GAME_MODES, type GameMode } from "@/types/seasonal";
import { ARENA_MODE_KEYS, type ArenaStoredMode } from "@/types/arena";

type Translate = ReturnType<typeof useI18n>["t"];
type AnyComparisonProfile = ComparisonProfile<PersistentComparisonScope> | ComparisonProfile<ArenaComparisonScope>;
type AnyComparisonCohort = ComparisonCohort<PersistentComparisonScope> | ComparisonCohort<ArenaComparisonScope>;

interface StoredProfile {
  profile: AnyComparisonProfile;
  updatedAt: number | null;
  profileSnapshot: string;
  payload: unknown;
}

interface ProfileLoadState {
  scopeKey: string;
  aid: number | null;
  data: StoredProfile | null;
  loading: boolean;
  error: string;
  missing: boolean;
}

interface CohortLoadState {
  scopeKey: string;
  aid: number | null;
  data: AnyComparisonCohort | null;
  loading: boolean;
  error: string;
}

function parseAid(value: string | null): number | null {
  if (!value) return null;
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? aid : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseCode(value: unknown): string {
  const body = record(value);
  return typeof body?.code === "string" ? body.code : "";
}

function captureStatus(value: unknown): string {
  const capture = record(record(value)?.capture);
  return typeof capture?.status === "string" ? capture.status : "";
}

function profileUpdatedAt(payload: unknown): number | null {
  const body = record(payload);
  if (!body) return null;
  const candidates = [
    body.profileUpdatedAt,
    record(body.freshness)?.profileUpdatedAt,
    record(body.arena)?.profileUpdatedAt,
    record(body.profile)?.profileUpdatedAt,
    record(body.stats)?.profileUpdatedAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return null;
}

function storedProfile(profile: AnyComparisonProfile, payload: unknown): StoredProfile {
  return {
    profile,
    updatedAt: profileUpdatedAt(payload),
    profileSnapshot: JSON.stringify(comparisonDossier(profile.scope, profile.identity.aid, payload)),
    payload,
  };
}

function profileRevision(profile: StoredProfile): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < profile.profileSnapshot.length; index += 1) {
    hash ^= profile.profileSnapshot.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${profile.updatedAt ?? "unknown"}-${(hash >>> 0).toString(36)}`;
}

function profileHref(scope: ComparisonScope, aid: number): string {
  const base = `/player/${appRouteMode(scope.mode)}/${aid}`;
  if (scope.mode === "arena") return `${base}?arenaMode=${scope.arenaMode}`;
  return scope.mode === "seasonal" ? `${base}?cycle=${encodeURIComponent(scope.cycleId)}` : base;
}

function cohortRevisionRequestUrl(scope: ComparisonScope, aid: number, revision: string): string {
  const url = new URL(comparisonCohortRequestUrl(scope, aid), "http://local");
  url.searchParams.set("revision", revision);
  return `${url.pathname}${url.search}`;
}

function useComparisonProfile(
  scope: ComparisonScope | null,
  scopeKey: string,
  aid: number | null,
  modeLabel: string,
  t: Translate,
  onRefreshed?: (profile: StoredProfile) => Promise<void> | void,
) {
  const [state, setState] = useState<ProfileLoadState>(() => ({
    scopeKey,
    aid,
    data: null,
    loading: Boolean(scope && aid !== null),
    error: "",
    missing: false,
  }));
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!scope || aid === null) {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      setState({ scopeKey, aid: null, data: null, loading: false, error: "", missing: false });
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    setState({ scopeKey, aid, data: null, loading: true, error: "", missing: false });
    loadPlayerProfileResponse<unknown>(comparisonProfileRequestUrl(scope, aid), { signal: controller.signal })
      .then(({ ok, status, body }) => {
        if (!active()) return;
        if (!ok) {
          const missing = status === 404 || responseCode(body) === "mode_profile_unavailable" || responseCode(body) === "profile_unavailable";
          setState({
            scopeKey,
            aid,
            data: null,
            loading: false,
            error: t(missing ? "compare.profileMissing" : "compare.profileLoadError", { mode: modeLabel }),
            missing,
          });
          return;
        }
        const adapted = adaptComparisonProfile(scope, aid, body) as AnyComparisonProfile | null;
        if (!adapted) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
        setState({ scopeKey, aid, data: storedProfile(adapted, body), loading: false, error: "", missing: false });
      })
      .catch(() => {
        if (active()) {
          setState({
            scopeKey,
            aid,
            data: null,
            loading: false,
            error: t("compare.profileLoadError", { mode: modeLabel }),
            missing: false,
          });
        }
      });
    return () => {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      controller.abort();
    };
  }, [aid, modeLabel, scope, scopeKey, t]);

  const refresh = useCallback(async (): Promise<RefreshCheckResult> => {
    if (!scope || aid === null) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
    const previous = state.scopeKey === scopeKey && state.aid === aid ? state.data : null;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    try {
      const { ok, body } = await loadPlayerProfileResponse<unknown>(
        comparisonProfileRequestUrl(scope, aid, { refresh: true }),
        { force: true, signal: controller.signal },
      );
      if (!active()) return "unchanged";
      if (!ok) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
      if (captureStatus(body) === "refresh_failed") throw new Error(t("player.refreshStatus.error"));
      const adapted = adaptComparisonProfile(scope, aid, body) as AnyComparisonProfile | null;
      if (!adapted) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
      const next = storedProfile(adapted, body);
      const changed = !previous || previous.updatedAt !== next.updatedAt || previous.profileSnapshot !== next.profileSnapshot;
      setState((current) => generation === requestGeneration.current && current.scopeKey === scopeKey && current.aid === aid
        ? { ...current, data: next, loading: false, error: "", missing: false }
        : current);
      if (active()) await onRefreshed?.(next);
      return changed ? "updated" : "unchanged";
    } catch (error) {
      setState((current) => generation === requestGeneration.current && current.scopeKey === scopeKey && current.aid === aid
        ? { ...current, loading: false }
        : current);
      throw error;
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }, [aid, modeLabel, onRefreshed, scope, scopeKey, state, t]);

  return { state, refresh };
}

function useComparisonCohort(scope: ComparisonScope | null, scopeKey: string, aid: number | null, t: Translate) {
  const [state, setState] = useState<CohortLoadState>(() => ({
    scopeKey,
    aid,
    data: null,
    loading: Boolean(scope && aid !== null),
    error: "",
  }));
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const revision = useRef<{ scopeKey: string; aid: number; value: string } | null>(null);
  const revisionIdentity = useRef<string | null>(null);

  useEffect(() => {
    if (!scope || aid === null) {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      revision.current = null;
      revisionIdentity.current = null;
      setState({ scopeKey, aid: null, data: null, loading: false, error: "" });
      return;
    }
    const identity = `${scopeKey}:${aid}`;
    if (revisionIdentity.current !== identity) {
      revisionIdentity.current = identity;
      revision.current = null;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    const currentRevision = revision.current?.scopeKey === scopeKey && revision.current.aid === aid
      ? revision.current.value
      : null;
    const requestUrl = currentRevision
      ? cohortRevisionRequestUrl(scope, aid, currentRevision)
      : comparisonCohortRequestUrl(scope, aid);
    setState({ scopeKey, aid, data: null, loading: true, error: "" });
    loadAverageJson<unknown>(requestUrl, { signal: controller.signal })
      .then((body) => {
        if (!active()) return;
        const adapted = adaptComparisonCohort(scope, aid, body) as AnyComparisonCohort | null;
        if (!adapted) throw new Error("cohort identity mismatch");
        setState({ scopeKey, aid, data: adapted, loading: false, error: "" });
      })
      .catch(() => {
        if (active()) {
          setState({ scopeKey, aid, data: null, loading: false, error: t("compare.cohortError") });
        }
      });
    return () => {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      controller.abort();
    };
  }, [aid, scope, scopeKey, t]);

  const reload = useCallback(async (profile: StoredProfile) => {
    if (!scope || aid === null) return;
    const nextRevision = profileRevision(profile);
    revision.current = { scopeKey, aid, value: nextRevision };
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    setState({ scopeKey, aid, data: null, loading: true, error: "" });
    try {
      const response = await fetch(cohortRevisionRequestUrl(scope, aid, nextRevision), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!active()) return;
      if (!response.ok) throw new Error("cohort request failed");
      const body: unknown = await response.json();
      if (!active()) return;
      const adapted = adaptComparisonCohort(scope, aid, body) as AnyComparisonCohort | null;
      if (!adapted) throw new Error("cohort identity mismatch");
      setState({ scopeKey, aid, data: adapted, loading: false, error: "" });
    } catch {
      if (active()) {
        setState({ scopeKey, aid, data: null, loading: false, error: t("compare.cohortError") });
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }, [aid, scope, scopeKey, t]);

  return { state, reload };
}

export default function ComparePage({ seasonalCycleId }: { seasonalCycleId?: string | null }) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const resolution = useMemo(
    () => comparisonScopeFromSearchParams(searchParams, seasonalCycleId ?? null),
    [searchParams, seasonalCycleId],
  );
  const scope = resolution.status === "available" ? resolution.scope : null;
  const scopeKey = scope ? `${scope.mode}:${scope.cycleId}:${scope.arenaMode}` : "";
  const rawMode = searchParams.get("mode");
  const visibleMode: GameMode = GAME_MODES.includes(rawMode as GameMode) ? rawMode as GameMode : "regular";
  const modeLabel = (mode: GameMode) => {
    if (mode === "regular") return t("fav.mode.regular");
    if (mode === "pve") return t("fav.mode.pve");
    if (mode === "arena") return t("fav.mode.arena");
    return t("fav.mode.seasonal");
  };
  const modeOptions = GAME_MODES
    .filter((mode) => seasonalCycleId || mode !== "seasonal")
    .map((mode) => ({ value: mode, label: modeLabel(mode) }));
  const activeModeLabel = modeLabel(scope?.mode ?? visibleMode);
  const primaryAid = parseAid(searchParams.get("aid"));
  const secondaryAid = parseAid(searchParams.get("vs"));
  const cohortController = useComparisonCohort(scope, scopeKey, primaryAid, t);
  const primary = useComparisonProfile(scope, scopeKey, primaryAid, activeModeLabel, t, cohortController.reload);
  const secondaryCohortController = useComparisonCohort(scope, scopeKey, secondaryAid, t);
  const secondary = useComparisonProfile(scope, scopeKey, secondaryAid, activeModeLabel, t, secondaryCohortController.reload);
  const cohortState = cohortController.state;
  const primaryCurrent = primary.state.scopeKey === scopeKey && primary.state.aid === primaryAid ? primary.state : null;
  const secondaryCurrent = secondary.state.scopeKey === scopeKey && secondary.state.aid === secondaryAid ? secondary.state : null;
  const secondaryCohortState = secondaryCohortController.state;
  const secondaryCohortCurrent = secondaryCohortState.scopeKey === scopeKey && secondaryCohortState.aid === secondaryAid ? secondaryCohortState : null;
  const cohortCurrent = cohortState.scopeKey === scopeKey && cohortState.aid === primaryAid ? cohortState : null;
  const primaryProfile = primaryCurrent?.data?.profile ?? null;
  const secondaryProfile = secondaryCurrent?.data?.profile ?? null;
  const primaryProgression = primaryAid === null ? null : {
    aid: primaryAid,
    nickname: primaryProfile?.nickname?.trim() || `#${primaryAid}`,
    updatedAt: primaryCurrent?.data?.updatedAt ?? null,
  };
  const secondaryProgression = secondaryAid === null ? null : {
    aid: secondaryAid,
    nickname: secondaryProfile?.nickname?.trim() || `#${secondaryAid}`,
    updatedAt: secondaryCurrent?.data?.updatedAt ?? null,
  };
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }),
    [lang],
  );

  function changeMode(mode: GameMode) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("mode", mode);
    params.delete("arenaMode");
    params.delete("cycle");
    if (mode === "seasonal" && seasonalCycleId) params.set("cycle", seasonalCycleId);
    const query = params.toString();
    router.replace(`/compare${query ? `?${query}` : ""}`, { scroll: false });
  }

  function updateSelection(slot: "primary" | "secondary", aid: number) {
    if (!scope) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(slot === "primary" ? "aid" : "vs", String(aid));
    const query = params.toString();
    router.replace(`/compare${query ? `?${query}` : ""}`, { scroll: false });
  }

  function changeArenaMode(arenaMode: ArenaStoredMode) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("arenaMode", arenaMode);
    router.replace(`/compare?${params.toString()}`, { scroll: false });
  }

  function profileCard(
    slot: "primary" | "secondary",
    label: string,
    aid: number | null,
    current: ProfileLoadState | null,
    refresh: () => Promise<RefreshCheckResult>,
  ) {
    if (!scope) return null;
    const loading = aid !== null && (current === null || current.loading);
    const data = current?.data ?? null;
    const name = data?.profile.nickname?.trim() || (aid !== null ? `#${aid}` : "");
    const updatedAt = data?.updatedAt ?? null;
    const dossier = aid !== null ? comparisonDossier(scope, aid, data?.payload) : null;
    return (
      <article className="comparison-identity" aria-busy={loading || undefined}>
        <div className="comparison-identity__person">
          {aid !== null && <ProfilePortrait key={`${scopeKey}:${aid}`} aid={aid} mode={scope.mode} cycleId={scope.cycleId} nickname={name || `#${aid}`} />}
          <div className="min-w-0">
            <p className="section-kicker">{label}</p>
            <h2 className="mt-2 break-words text-xl font-bold text-[var(--foreground)]">{name || t("compare.choosePlayer")}</h2>
            <ProfilePrestige level={dossier?.values.prestige} />
            {aid !== null && <p className="mt-1 text-sm text-[var(--muted)]">#{aid}</p>}
            {dossier && <div className="comparison-identity__meta">
              {dossier.side && <span>{t("player.sideLabel", { side: dossier.side })}</span>}
              {dossier.values.level !== null && <span>{t("profile.levelValue", { n: dossier.values.level })}</span>}
            </div>}
            {updatedAt !== null && (
              <time className="mt-1 block text-xs text-[var(--muted)]" dateTime={new Date(updatedAt).toISOString()}>
                {t("player.profileUpdated", { date: dateFormatter.format(updatedAt) })}
              </time>
            )}
            {dossier?.lastAccessAt != null && <time dateTime={new Date(dossier.lastAccessAt).toISOString()}>
              {t("player.lastPlayed", { date: dateFormatter.format(dossier.lastAccessAt) })}
            </time>}
          </div>
        </div>
        {aid !== null && (
          <div className="comparison-identity__actions">
            <RefreshButton
              key={`${slot}:${scopeKey}:${aid}`}
              aid={aid}
              mode={scope.mode}
              updatedAt={updatedAt}
              missing={current?.missing}
              direct
              onCheck={refresh}
            />
            <Link prefetch={false} href={profileHref(scope, aid)} className="ghost-button">
              {t("compare.fullProfile")}
            </Link>
          </div>
        )}
        {aid === null && <p className="mt-4 text-sm text-[var(--muted)]">{t("compare.choosePlayer")}</p>}
        {loading && <p className="mt-4 text-sm text-[var(--muted)]" role="status">{t("common.loading")}</p>}
        {!loading && current?.error && <p className="mt-4 text-sm text-[var(--danger)]" role="alert">{current.error}</p>}
      </article>
    );
  }

  const bothPlayersSelected = primaryAid !== null && secondaryAid !== null;

  return (
    <main className="page-frame comparison-page">
      <header>
        <p className="page-kicker">{t("compare.pageKicker")}</p>
        <h1 className="page-title">{t("compare.pageTitle")}</h1>
        <p className="mt-4 max-w-3xl text-[var(--muted)]">{t("compare.pageDescription")}</p>
      </header>

      <div className="mt-7 flex flex-wrap items-end justify-between gap-4">
        <SegmentedRadio
          name="compare-mode"
          legend={t("mode.selectorAria")}
          value={scope?.mode ?? visibleMode}
          options={modeOptions}
          onChange={changeMode}
        />
        {scope?.mode === "seasonal" && (
          <span className="rounded-full border border-[var(--card-border)] px-3 py-1 text-sm text-[var(--muted-strong)]">
            {t("compare.cycle", { cycle: scope.cycleId })}
          </span>
        )}
      </div>

      {scope?.mode === "arena" && <SegmentedRadio
        className="comparison-arena-scopes mt-5"
        name="compare-arena-mode"
        legend={t("arena.modePicker.label")}
        value={scope.arenaMode}
        options={(["overall", ...ARENA_MODE_KEYS] as const).map(mode => ({ value: mode, label: t(mode === "overall" ? "compare.arenaOverall" : "arena.mode." + mode) }))}
        onChange={changeArenaMode}
      />}

      {!scope && (
        <section className="surface mt-6 p-6" role="status" aria-live="polite">
          <p className="section-kicker">{modeLabel(visibleMode)}</p>
          <h2 className="section-heading mt-2">
            {t(visibleMode === "seasonal" ? "seasonal.unavailable" : "mode.unavailable")}
          </h2>
          <p className="mt-3 max-w-2xl text-[var(--muted)]">
            {t(visibleMode === "seasonal" ? "seasonal.unavailableDescription" : "mode.unavailableDescription")}
          </p>
        </section>
      )}

      {scope && (
        <>
          <section className="mt-8 grid gap-5 md:grid-cols-2" aria-label={t("compare.searchPlayers")}>
            <div className="min-w-0">
              <h2 className="section-heading">{t("compare.primaryPlayer")}</h2>
              <SearchBar
                key={`primary:${scopeKey}`}
                fixedMode={scope.mode}
                cycleId={scope.cycleId}
                onSelect={(aid) => updateSelection("primary", aid)}
              />
            </div>
            <div className="min-w-0">
              <h2 className="section-heading">{t("compare.secondaryPlayer")}</h2>
              <SearchBar
                key={`secondary:${scopeKey}`}
                fixedMode={scope.mode}
                cycleId={scope.cycleId}
                onSelect={(aid) => updateSelection("secondary", aid)}
              />
            </div>
          </section>

          <section className="comparison-identities">
            {profileCard("primary", t("compare.primaryPlayer"), primaryAid, primaryCurrent, primary.refresh)}
            {profileCard("secondary", t("compare.secondaryPlayer"), secondaryAid, secondaryCurrent, secondary.refresh)}
          </section>

        </>
      )}

      {scope && <ComparisonDossiers
        key={scopeKey}
        scope={scope}
        primaryAid={primaryAid}
        secondaryAid={secondaryAid}
        primaryPayload={primaryCurrent?.data?.payload}
        secondaryPayload={secondaryCurrent?.data?.payload}
        cohorts={[
          { data: cohortCurrent?.data ?? null, loading: primaryAid !== null && (cohortCurrent === null || cohortCurrent.loading), error: cohortCurrent?.error ?? "" },
          { data: secondaryCohortCurrent?.data ?? null, loading: secondaryAid !== null && (secondaryCohortCurrent === null || secondaryCohortCurrent.loading), error: secondaryCohortCurrent?.error ?? "" },
        ]}
        progression={bothPlayersSelected && scope.mode !== "arena" ? <CompareProgressionSection
          key={`${scopeKey}:${primaryAid}:${secondaryAid}`}
          mode={scope.mode}
          cycleId={scope.cycleId}
          primary={primaryProgression}
          secondary={secondaryProgression}
        /> : <p className="dossier-note">{t("compare.secondPrompt")}</p>}
      />}
    </main>
  );
}

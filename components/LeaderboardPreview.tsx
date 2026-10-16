"use client";

import Link from "next/link";
import Image from "next/image";
import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useId, useCallback, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import ProfilePortrait from "@/components/ProfilePortrait";
import { LEADERBOARD_PREVIEW_DELAY_MS, LEADERBOARD_PREVIEW_CLOSE_MS, previewRatio } from "@/lib/leaderboard-preview";
import type { LeaderboardMeta } from "@/types/leaderboard";
import type { LeaderboardPreview } from "@/types/leaderboard-preview";

type Target = { id: string; aid: number; nickname: string; href: string; element: HTMLAnchorElement; focus?: boolean };
type PreviewContext = { id: string; active: string | null; enter: (target: Target, immediate?: boolean) => void; leave: (sourceId?: string) => void; close: (restore?: boolean) => void };
const Context = createContext<PreviewContext | null>(null);
// Bounded session cache; closing cancels an in-flight request and never stores partial results.
const cache = new Map<string, { expiresAt: number; value: LeaderboardPreview }>();
const finePointer = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

export function LeaderboardPreviewProvider({ meta, children }: { meta: LeaderboardMeta; children: ReactNode }) {
  const { t, lang } = useI18n();
  const id = useId();
  const [target, setTarget] = useState<Target | null>(null);
  const [data, setData] = useState<LeaderboardPreview | null>(null);
  const [error, setError] = useState(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0 });
  const [touch, setTouch] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const current = useRef<Target | null>(null);
  const pending = useRef<Target | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const restoring = useRef(false);
  const pointer = useRef({ x: -1, y: -1 });
  const keyboard = useRef(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
    pending.current = null;
  }, []);
  const close = useCallback((restore = false) => {
    clearTimers();
    controller.current?.abort();
    const previous = current.current;
    current.current = null;
    setTarget(null);
    if (restore) {
      restoring.current = true;
      previous?.element.focus({ preventScroll: true });
      restoring.current = false;
    }
  }, [clearTimers]);

  const enter = useCallback((next: Target, immediate = false) => {
    if (restoring.current) return;
    keyboard.current = next.focus === true || next.element.matches(":focus-visible");
    clearTimers();
    if (current.current?.element === next.element) return;
    // Switching nicknames closes the old card immediately and starts a fresh dwell timer.
    controller.current?.abort();
    current.current = null;
    setTarget(null);
    pending.current = next;
    const show = () => {
      pending.current = null;
      if (!next.element.isConnected) return;
      current.current = next;
      setData(null);
      setError(false);
      setTouch(!finePointer());
      setTarget(next);
      const params = new URLSearchParams({ aid: String(next.aid), mode: meta.mode });
      if (meta.cycleId) params.set("cycle", meta.cycleId);
      if (meta.arenaMode) params.set("arenaMode", meta.arenaMode);
      const key = `${meta.generation}:${params}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) { setData(cached.value); return; }
      const request = new AbortController();
      controller.current = request;
      fetch(`/api/leaderboard/preview?${params}`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]) }).then(async (response) => {
        if (!response.ok) throw new Error("preview unavailable");
        const value = await response.json() as LeaderboardPreview;
        if (request.signal.aborted) return;
        if (value.aid !== next.aid || value.mode !== meta.mode || value.cycleId !== meta.cycleId || value.arenaMode !== meta.arenaMode) throw new Error("preview identity mismatch");
        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(key, { expiresAt: Date.now() + 60_000, value });
        setData(value);
      }).catch(() => { if (!request.signal.aborted) setError(true); });
    };
    if (immediate) show();
    else openTimer.current = setTimeout(show, LEADERBOARD_PREVIEW_DELAY_MS);
  }, [clearTimers, meta.mode, meta.cycleId, meta.arenaMode, meta.generation]);

  const inside = useCallback(() => {
    const anchor = current.current?.element;
    const popup = card.current;
    if (!anchor || !popup) return false;
    const { x, y } = pointer.current;
    const a = anchor.getBoundingClientRect(), b = popup.getBoundingClientRect();
    const hit = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (hit(a) || hit(b)) return true;
    // A 12px corridor between the trigger and card lets the pointer cross slowly.
    if (b.left >= a.right) return x >= a.right && x <= b.left && y >= Math.min(a.top, b.top) && y <= Math.max(a.bottom, b.bottom);
    if (b.right <= a.left) return x >= b.right && x <= a.left && y >= Math.min(a.top, b.top) && y <= Math.max(a.bottom, b.bottom);
    return x >= Math.min(a.left, b.left) && x <= Math.max(a.right, b.right) &&
      (b.top >= a.bottom ? y >= a.bottom && y <= b.top : y >= b.bottom && y <= a.top);
  }, []);
  const leave = useCallback((sourceId?: string) => {
    // Leaving the old portal during a switch must not cancel the new nickname's timer.
    if (sourceId && pending.current?.id === sourceId) {
      if (openTimer.current) clearTimeout(openTimer.current);
      pending.current = null;
    }
    if (sourceId && current.current && current.current.id !== sourceId) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (pending.current) return;
      if (inside()) return;
      if (keyboard.current && (card.current?.contains(document.activeElement) || current.current?.element === document.activeElement)) return;
      close();
    }, LEADERBOARD_PREVIEW_CLOSE_MS);
  }, [inside, close]);

  useEffect(() => () => { clearTimers(); controller.current?.abort(); }, [clearTimers]);
  useEffect(() => {
    if (!target) return;
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (touch) return;
      if (inside()) { if (closeTimer.current) clearTimeout(closeTimer.current); }
      else leave();
    };
    const down = (event: PointerEvent) => {
      keyboard.current = false;
      if (!card.current?.contains(event.target as Node) && !target.element.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      keyboard.current = true;
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      if (touch && event.key === "Tab" && card.current) {
        const controls = [...card.current.querySelectorAll<HTMLElement>("button, a[href]")];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [target, touch, inside, leave, close]);

  useLayoutEffect(() => {
    if (!target || !card.current) return;
    const position = () => {
      if (!target.element.isConnected || !target.element.getClientRects().length) { close(); return; }
      const popup = card.current!;
      const a = target.element.getBoundingClientRect(), b = popup.getBoundingClientRect();
      const margin = 12;
      let left = Math.min(Math.max(margin, a.left - 16), innerWidth - b.width - margin), top = a.bottom + margin;
      if (touch) { left = (innerWidth - b.width) / 2; top = Math.max(margin, innerHeight - b.height - margin); }
      else if (a.right + margin + b.width <= innerWidth - margin) {
        left = a.right + margin;
        top = Math.max(margin, Math.min(a.top, innerHeight - b.height - margin));
      } else if (a.left - b.width - margin >= margin) {
        left = a.left - b.width - margin;
        top = Math.max(margin, Math.min(a.top, innerHeight - b.height - margin));
      } else if (top + b.height > innerHeight - margin) {
        if (a.top - b.height - margin >= margin) top = a.top - b.height - margin;
        else top = Math.max(margin, innerHeight - b.height - margin);
      }
      setPlacement({ left, top });
    };
    position();
    if (target.focus && !card.current.contains(document.activeElement)) card.current.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [target, data, error, touch, lang, close]);

  const format = (value: number | null, digits = 0) => value === null ? "—" : value.toLocaleString(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const mode = meta.mode === "pvp-season" ? "seasonal" : meta.mode;
  return <Context.Provider value={{ id, active: target?.id ?? null, enter, leave, close }}>
    {children}
    {target && createPortal(<>
      {touch && <div className="leaderboard-preview-backdrop" onClick={() => close(true)} />}
      <div ref={card} id={id} className="leaderboard-preview" role="dialog" aria-modal={touch || undefined} aria-labelledby={`${id}-name`}
        style={placement} onPointerEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current); }} onPointerLeave={() => { if (!touch) leave(); }}
        onBlur={(event) => { if (!touch && !event.currentTarget.contains(event.relatedTarget)) leave(); }}>
        <button className="leaderboard-preview__close" type="button" aria-label={t("common.close")} onClick={() => close(true)}>×</button>
        <div className="leaderboard-preview__identity">
          <ProfilePortrait key={`${mode}:${target.aid}`} aid={target.aid} mode={mode} cycleId={meta.cycleId ?? undefined} nickname={target.nickname} />
          <div><div className="leaderboard-preview__name"><h2 id={`${id}-name`} title={data?.nickname ?? target.nickname}>{data?.nickname ?? target.nickname}</h2>
            {data?.prestige != null && Number.isSafeInteger(data.prestige) && data.prestige > 0 && <Image src={`https://assets.tarkov.dev/prestige-${data.prestige}-icon.webp`} width={24} height={24} unoptimized referrerPolicy="no-referrer" alt={t("player.prestigeLabel", { n: data.prestige })} onError={(event) => { event.currentTarget.style.display = "none"; }} />}
          </div><div className="leaderboard-preview__meta">
            {meta.mode === "arena" && meta.arenaMode && <span className="leaderboard-preview__mode">{t("fav.mode.arena")} · {t("arena.mode." + meta.arenaMode)}</span>}
            {data?.side && <span>{data.side}</span>}
            {data?.level != null && <span>{t("leaderboard.preview.level", { n: data.level })}</span>}
            {data?.updatedAt != null && data.updatedAt > 0 && <span>{t("leaderboard.preview.updated", { date: new Date(data.updatedAt).toLocaleDateString(lang, { day: "numeric", month: "short" }) })}</span>}
          </div></div>
        </div>
        {!data ? <p className="leaderboard-preview__status" role="status">{t(error ? "leaderboard.preview.unavailable" : "common.loading")}</p> : <>
          {meta.mode === "arena" ? <div className="leaderboard-preview__activity leaderboard-preview__activity--arena">
            <span>{t("leaderboard.hoursValue", { v: format(data.hours, 1) })}<small>{t("arena.account.hours")}</small></span>
            <span>{format(data.raids)}<small>{t("arena.counter.matches")}</small></span>
            <span title={t("arena.combat.bestArp")}>{format(data.bestArp ?? null)}<small>{t("arena.bestArp")}</small></span>
          </div> : <div className="leaderboard-preview__activity"><span>{t("leaderboard.hoursValue", { v: format(data.hours, 1) })}</span><span>{t("leaderboard.preview.raids", { n: format(data.raids) })}</span></div>}
          <dl className="leaderboard-preview__metrics">{data.metrics.map((metric) => {
            const comparison = previewRatio(metric.value, metric.average);
            const label = metric.note ? t(metric.note) : !comparison ? t("leaderboard.preview.noComparison") : comparison.direction === "equal" ? t("leaderboard.preview.equal")
              : comparison.ratio === null ? t(comparison.direction === "above" ? "leaderboard.preview.above" : "leaderboard.preview.below")
                : t(comparison.direction === "above" ? "leaderboard.preview.aboveTimes" : "leaderboard.preview.belowTimes", { n: format(comparison.ratio, 2) });
            return <div key={metric.label} data-direction={comparison?.direction ?? "neutral"}><dt>{t(metric.label)}</dt><dd>{format(metric.value, metric.digits)}{metric.percent && metric.value !== null ? "%" : ""}<small>{label}</small></dd></div>;
          })}</dl>
          <dl className="leaderboard-preview__totals">{data.totals.map((total) => <div key={total.label}><dd>{format(total.value)}</dd><dt>{t(total.label)}</dt></div>)}</dl>
        </>}
        <div className="leaderboard-preview__footer"><Link href={target.href} prefetch={false}>{t("home.openProfile")} <span aria-hidden="true">↗</span></Link></div>
      </div>
    </>, document.body)}
  </Context.Provider>;
}

export function LeaderboardPreviewLink({ aid, nickname, href, className }: { aid: number; nickname: string; href: string; className: string }) {
  const context = useContext(Context);
  const linkId = useId();
  const pointerType = useRef("mouse");
  return <Link href={href} prefetch={false} className={className} aria-haspopup="dialog"
    aria-expanded={context?.active === linkId} aria-controls={context?.active === linkId ? context.id : undefined}
    onPointerDown={(event) => { pointerType.current = event.pointerType; }}
    onPointerEnter={(event) => { if (event.pointerType === "mouse" && finePointer()) context?.enter({ id: linkId, aid, nickname, href, element: event.currentTarget }); }}
    onPointerLeave={() => { if (finePointer()) context?.leave(linkId); }}
    onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) context?.enter({ id: linkId, aid, nickname, href, element: event.currentTarget }); }}
    onBlur={() => { if (finePointer()) context?.leave(linkId); }}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (pointerType.current === "touch" || !finePointer()) { event.preventDefault(); context?.enter({ id: linkId, aid, nickname, href, element: event.currentTarget, focus: true }, true); }
      else context?.close();
    }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); context?.enter({ id: linkId, aid, nickname, href, element: event.currentTarget, focus: true }, true); } }}>
    {nickname || `#${aid}`}
  </Link>;
}

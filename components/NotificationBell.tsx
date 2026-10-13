"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import type { UserNotification } from "@/lib/notifications";

type Inbox = { notifications: UserNotification[]; unreadCount: number };

export default function NotificationBell() {
  const { t, lang } = useI18n();
  const pathname = usePathname();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const [inbox, setInbox] = useState<Inbox>({ notifications: [], unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 80, right: 12 });

  const load = useCallback(async (ids?: string[]) => {
    if (mutating.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (ids) { mutating.current = true; setSaving(true); }
    try {
      const response = await fetch("/api/notifications", {
        cache: "no-store", signal: controller.signal,
        ...(ids ? { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) } : {}),
      });
      if (!response.ok) throw new Error("Notification request failed");
      const data = await response.json() as Inbox;
      if (mounted.current && !controller.signal.aborted) { setInbox(data); setError(false); }
    } catch {
      if (mounted.current && !controller.signal.aborted) setError(true);
    } finally {
      if (ids) mutating.current = false;
      if (mounted.current && !controller.signal.aborted) { setLoading(false); setSaving(false); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      request.current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  useEffect(() => { panel.current?.hidePopover(); }, [pathname]);

  const placePanel = useCallback(() => {
    const rect = bell.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(420, window.innerWidth - 24);
    setPosition({
      top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 160)),
      right: Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 12)),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", placePanel);
    window.addEventListener("scroll", placePanel, true);
    return () => {
      window.removeEventListener("resize", placePanel);
      window.removeEventListener("scroll", placePanel, true);
    };
  }, [open, placePanel]);

  const unread = inbox.notifications.filter((item) => !item.read);
  return (
    <>
      <button ref={bell} type="button" className="tactical-control notification-bell"
        popoverTarget={id} aria-controls={id} aria-expanded={open} aria-haspopup="dialog"
        aria-label={inbox.unreadCount > 0 ? t("notifications.unread", { n: inbox.unreadCount }) : t("notifications.title")}
        onClick={placePanel}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4M12 2V1" />
        </svg>
        {inbox.unreadCount > 0 && <span className="notification-bell__badge" aria-hidden="true">{inbox.unreadCount > 99 ? "99+" : inbox.unreadCount}</span>}
      </button>
      <div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
        className="notification-panel" style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 12}px)` }}
        onToggle={(event) => {
          const visible = event.currentTarget.matches(":popover-open");
          setOpen(visible);
          if (visible) { placePanel(); void load(); }
        }}>
        <div className="notification-panel__header">
          <h2 id={`${id}-title`}>{t("notifications.title")}</h2>
          <button type="button" className="notification-panel__close" popoverTarget={id} popoverTargetAction="hide" aria-label={t("notifications.close")}><span aria-hidden="true">×</span></button>
        </div>
        <div className="notification-panel__toolbar">
          <span>{t("notifications.unread", { n: inbox.unreadCount })}</span>
          <button type="button" disabled={unread.length === 0 || saving || loading} onClick={() => void load(unread.map((item) => item.id))}>{t("notifications.readAll")}</button>
        </div>
        {error && <div className="notification-panel__message" role="alert"><p>{t("notifications.error")}</p><button type="button" disabled={saving} onClick={() => void load()}>{t("notifications.retry")}</button></div>}
        {loading ? <p className="notification-panel__message" role="status">{t("common.loading")}</p> : inbox.notifications.length === 0 && !error ? (
          <div className="notification-panel__message"><p>{t("notifications.empty")}</p><small>{t("notifications.emptyHint")}</small></div>
        ) : (
          <ul className="notification-panel__list" aria-busy={saving}>
            {inbox.notifications.map((item) => (
              <li key={item.id} className={`notification-item ${item.read ? "" : "is-unread"}`}>
                <span className="notification-item__icon" aria-hidden="true">{item.kind === "news" ? "i" : "✓"}</span>
                <div className="notification-item__content">
                  <span className="notification-item__category">{t(item.kind === "news" ? "notifications.news" : "notifications.report")}</span>
                  <Link href={item.href} prefetch={false} onClick={() => { if (!item.read) void load([item.id]); panel.current?.hidePopover(); }}>
                    <strong>{item.kind === "news" ? item.title : t("notifications.reportTitle", { aid: item.aid ?? "" })}</strong>
                    <p>{item.kind === "news" ? item.body : t("notifications.status." + item.status)}</p>
                  </Link>
                  <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" })}</time>
                </div>
                {!item.read && <button type="button" className="notification-item__read" disabled={saving} aria-label={t("notifications.readOne")} title={t("notifications.readOne")} onClick={() => void load([item.id])}><span aria-hidden="true">✓</span></button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

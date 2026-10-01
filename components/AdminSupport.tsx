"use client";

import { useState } from "react";
import type { FundraisingGoal, NotificationLevel, SupportNotification } from "@/lib/admin/support-db";

type T = (key: string, vars?: Record<string, string | number>) => string;

const LEVELS: NotificationLevel[] = ["info", "warn", "danger"];

type SupportResponse = {
  ok?: boolean;
  error?: string;
  notification?: SupportNotification;
  notifications?: SupportNotification[];
  goal?: FundraisingGoal;
  goals?: FundraisingGoal[];
};

async function postSupport(action: string, extra: Record<string, unknown>): Promise<SupportResponse> {
  const response = await fetch("/api/admin/support", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as SupportResponse | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" && body.error ? body.error : String(response.status));
  }
  return body ?? {};
}

export default function AdminSupport({ notifications, goals, available = true, t }: {
  notifications: SupportNotification[];
  goals: FundraisingGoal[];
  available?: boolean;
  t: T;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftHref, setDraftHref] = useState("");
  const [draftLevel, setDraftLevel] = useState<NotificationLevel>("info");

  async function mutate(action: string, extra: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      return await postSupport(action, extra);
    } catch {
      setError(t("admin.error.save"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function handleCreate() {
    if (!draftTitle.trim() || !draftBody.trim()) {
      setError(`${t("admin.error.save")}: ${t("admin.support.invalidText")}`);
      return;
    }
    void mutate("create_notification", {
      title: draftTitle,
      body: draftBody,
      href: draftHref.trim() ? draftHref.trim() : null,
      level: draftLevel,
    }).then((result) => {
      if (!result) return;
      setDraftTitle("");
      setDraftBody("");
      setDraftHref("");
      setDraftLevel("info");
    });
  }

  return (
    <div className="admin-stack">
      {available === false && <div className="admin-notice" role="status">{t("admin.support.unavailable")}</div>}
      {error && <div className="admin-notice admin-notice--error" role="alert">{error}</div>}

      <section className="data-panel admin-panel" aria-label={t("admin.support.notifications")}>
        <h2 className="section-heading">{t("admin.support.notifications")}</h2>
        <p className="admin-chart-description">{t("admin.support.notificationsDescription")}</p>
        {notifications.length === 0
          ? <p className="admin-empty">{t("admin.support.noNotifications")}</p>
          : <ul className="admin-support-list">
            {notifications.map((notification) => (
              <NotificationRow key={notification.id} notification={notification} busy={busy} t={t} onMutate={mutate} />
            ))}
          </ul>}
        <div className="admin-support-form">
          <label>
            <span>{t("admin.support.title")}</span>
            <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} maxLength={120} placeholder={t("admin.support.title")} disabled={busy} />
          </label>
          <label>
            <span>{t("admin.support.body")}</span>
            <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} maxLength={1000} rows={3} placeholder={t("admin.support.body")} disabled={busy} />
          </label>
          <div className="admin-moderation">
            <label>
              <span>{t("admin.support.link")}</span>
              <input value={draftHref} onChange={(event) => setDraftHref(event.target.value)} maxLength={300} placeholder={t("admin.support.linkPlaceholder")} disabled={busy} />
            </label>
            <label>
              <span>{t("admin.support.level")}</span>
              <select value={draftLevel} onChange={(event) => setDraftLevel(event.target.value as NotificationLevel)} disabled={busy}>
                {LEVELS.map((level) => <option key={level} value={level}>{t("admin.support.level." + level)}</option>)}
              </select>
            </label>
            <button type="button" className="tactical-button" disabled={busy || !draftTitle.trim() || !draftBody.trim()} onClick={handleCreate}>
              {t("admin.support.create")}
            </button>
          </div>
        </div>
      </section>

      <GoalsSection goals={goals} busy={busy} t={t} onMutate={mutate} onValidationError={(key) => setError(`${t("admin.error.save")}: ${t(key)}`)} />
    </div>
  );
}

function NotificationRow({ notification, busy, t, onMutate }: {
  notification: SupportNotification;
  busy: boolean;
  t: T;
  onMutate: (action: string, extra: Record<string, unknown>) => Promise<SupportResponse | null>;
}) {
  const [title, setTitle] = useState(notification.title);
  const [body, setBody] = useState(notification.body);
  const [href, setHref] = useState(notification.href ?? "");
  const [level, setLevel] = useState<NotificationLevel>(notification.level);

  const dirty = title !== notification.title
    || body !== notification.body
    || href !== (notification.href ?? "")
    || level !== notification.level;

  function handleSave() {
    void onMutate("update_notification", {
      id: notification.id,
      title,
      body,
      href: href.trim() ? href.trim() : null,
      level,
    });
  }

  function handleDelete() {
    if (!window.confirm(t("admin.support.deleteConfirm", { title: notification.title }))) return;
    void onMutate("delete_notification", { id: notification.id });
  }

  return (
    <li className="admin-support-row">
      <div className="admin-support-row__head">
        <span className="admin-badge">{t("admin.support.level." + notification.level)}</span>
        <label className="admin-support-toggle">
          <input
            type="checkbox"
            checked={notification.isActive}
            disabled={busy}
            onChange={(event) => { void onMutate("set_notification_active", { id: notification.id, active: event.target.checked }); }}
          />
          {notification.isActive ? t("admin.support.live") : t("admin.support.off")}
        </label>
        <button type="button" className="ghost-button admin-danger" disabled={busy} onClick={handleDelete}>{t("admin.support.delete")}</button>
      </div>
      <div className="admin-moderation">
        <label>
          <span>{t("admin.support.title")}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={busy} />
        </label>
        <label>
          <span>{t("admin.support.level")}</span>
          <select value={level} onChange={(event) => setLevel(event.target.value as NotificationLevel)} disabled={busy}>
            {LEVELS.map((item) => <option key={item} value={item}>{t("admin.support.level." + item)}</option>)}
          </select>
        </label>
      </div>
      <label>
        <span>{t("admin.support.body")}</span>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={1000} rows={3} disabled={busy} />
      </label>
      <div className="admin-moderation">
        <label>
          <span>{t("admin.support.link")}</span>
          <input value={href} onChange={(event) => setHref(event.target.value)} maxLength={300} placeholder={t("admin.support.linkPlaceholder")} disabled={busy} />
        </label>
        <button type="button" className="ghost-button" disabled={busy || !dirty} onClick={handleSave}>{t("admin.support.save")}</button>
      </div>
    </li>
  );
}

function GoalsSection({ goals, busy, t, onMutate, onValidationError }: {
  goals: FundraisingGoal[];
  busy: boolean;
  t: T;
  onMutate: (action: string, extra: Record<string, unknown>) => Promise<SupportResponse | null>;
  onValidationError: (messageKey: string) => void;
}) {
  const [draftGoal, setDraftGoal] = useState("");
  const [draftCollected, setDraftCollected] = useState("");
  const [draftRate, setDraftRate] = useState("");

  function handleCreate() {
    const goal = Number(draftGoal.trim());
    if (!Number.isFinite(goal) || goal <= 0) {
      onValidationError("admin.support.invalidGoal");
      return;
    }
    void onMutate("create_goal", {
      goalRub: goal,
      collectedRub: Number(draftCollected.trim()) || 0,
      usdRate: Number(draftRate.trim()) || 1,
    }).then((result) => {
      if (!result) return;
      setDraftGoal("");
      setDraftCollected("");
      setDraftRate("");
    });
  }

  return (
    <section className="data-panel admin-panel" aria-label={t("admin.support.goals")}>
      <h2 className="section-heading">{t("admin.support.goals")}</h2>
      <p className="admin-chart-description">{t("admin.support.goalsDescription")}</p>
      {goals.length === 0
        ? <p className="admin-empty">{t("admin.support.noGoals")}</p>
        : <ul className="admin-support-list">
            {goals.map((goal) => <GoalRow key={goal.id} goal={goal} busy={busy} t={t} onMutate={onMutate} />)}
          </ul>}
      <div className="admin-moderation" style={{ marginTop: 16 }}>
        <label>
          <span>{t("admin.support.goalRub")}</span>
          <input value={draftGoal} onChange={(event) => setDraftGoal(event.target.value)} inputMode="decimal" placeholder="10000" disabled={busy} />
        </label>
        <label>
          <span>{t("admin.support.collectedRub")}</span>
          <input value={draftCollected} onChange={(event) => setDraftCollected(event.target.value)} inputMode="decimal" placeholder="0" disabled={busy} />
        </label>
        <label>
          <span>{t("admin.support.usdRate")}</span>
          <input value={draftRate} onChange={(event) => setDraftRate(event.target.value)} inputMode="decimal" placeholder="100" disabled={busy} />
        </label>
        <button type="button" className="tactical-button" disabled={busy || !draftGoal.trim()} onClick={handleCreate}>
          {t("admin.support.createGoal")}
        </button>
      </div>
    </section>
  );
}

function GoalRow({ goal, busy, t, onMutate }: {
  goal: FundraisingGoal;
  busy: boolean;
  t: T;
  onMutate: (action: string, extra: Record<string, unknown>) => Promise<SupportResponse | null>;
}) {
  const [collected, setCollected] = useState(String(goal.collectedRub));
  const [target, setTarget] = useState(String(goal.goalRub));
  const [rate, setRate] = useState(String(goal.usdRate));

  const dirty = Number(collected) !== goal.collectedRub || Number(target) !== goal.goalRub || Number(rate) !== goal.usdRate;

  function handleSave() {
    void onMutate("update_goal", {
      id: goal.id,
      collectedRub: Number(collected),
      goalRub: Number(target),
      usdRate: Number(rate),
    });
  }

  function handleDelete() {
    if (!window.confirm(t("admin.support.deleteGoalConfirm"))) return;
    void onMutate("delete_goal", { id: goal.id });
  }

  return (
    <li className="admin-support-row">
      <div className="admin-support-row__head">
        <strong>{t("admin.support.goalRub")} {goal.goalRub}</strong>
        {goal.isActive
          ? <span className="admin-badge">{t("admin.support.live")}</span>
          : <button type="button" className="ghost-button" disabled={busy} onClick={() => { void onMutate("set_goal_active", { id: goal.id }); }}>{t("admin.support.setActive")}</button>}
        <button type="button" className="ghost-button admin-danger" disabled={busy} onClick={handleDelete}>{t("admin.support.deleteGoal")}</button>
      </div>
      <div className="admin-moderation">
        <label>
          <span>{t("admin.support.collectedRub")}</span>
          <input value={collected} onChange={(event) => setCollected(event.target.value)} inputMode="decimal" disabled={busy} />
        </label>
        <label>
          <span>{t("admin.support.goalRub")}</span>
          <input value={target} onChange={(event) => setTarget(event.target.value)} inputMode="decimal" disabled={busy} />
        </label>
        <label>
          <span>{t("admin.support.usdRate")}</span>
          <input value={rate} onChange={(event) => setRate(event.target.value)} inputMode="decimal" disabled={busy} />
        </label>
        <button type="button" className="ghost-button" disabled={busy || !dirty} onClick={handleSave}>{t("admin.support.save")}</button>
      </div>
    </li>
  );
}

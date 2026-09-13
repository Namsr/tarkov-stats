"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ShowcaseGroup, ShowcaseItem } from "@/lib/admin/showcase-db";

type T = (key: string, vars?: Record<string, string | number>) => string;

type ShowcaseResponse = {
  ok?: boolean;
  error?: string;
  group?: ShowcaseGroup;
  groups?: ShowcaseGroup[];
};

async function postShowcase(action: string, extra: Record<string, unknown>): Promise<ShowcaseResponse> {
  const response = await fetch("/api/admin/showcase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as ShowcaseResponse | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" && body.error ? body.error : String(response.status));
  }
  return body ?? {};
}

function ShowcasePanel({ groups, available = true, t, lang, onChange }: {
  groups: ShowcaseGroup[];
  available?: boolean;
  t: T;
  lang: string;
  onChange: (groups: ShowcaseGroup[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => {
      if (current != null && groups.some((group) => group.id === current)) return current;
      return groups.find((group) => group.isActive)?.id ?? groups[0].id;
    });
  }, [groups]);

  const selected = groups.find((group) => group.id === selectedId)
    ?? groups.find((group) => group.isActive)
    ?? groups[0]
    ?? null;
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const formatCount = (value: number) => new Intl.NumberFormat(locale).format(value);

  async function mutate(action: string, extra: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await postShowcase(action, extra);
      if (!result.ok || !Array.isArray(result.groups)) throw new Error("Invalid showcase response");
      onChange(result.groups);
      if (action === "create_group" && result.group) setSelectedId(result.group.id);
      return true;
    } catch {
      setError(t("admin.error.save"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) {
      setError(`${t("admin.error.save")}: ${t("admin.showcase.invalidName")}`);
      return;
    }
    void mutate("create_group", { name }).then((saved) => { if (saved) setNewGroupName(""); });
  }

  function handleDeleteGroup(id: number, name: string) {
    if (!window.confirm(t("admin.showcase.deleteConfirm", { name }))) return;
    void mutate("delete_group", { id });
  }

  return (
    <div className="admin-stack">
      {available === false && <div className="admin-notice" role="status">{t("admin.showcase.unavailable")}</div>}
      {error && <div className="admin-notice admin-notice--error" role="alert">{error}</div>}
      <section className="data-panel admin-panel" aria-label={t("admin.showcase.groups")}>
        <h2 className="section-heading">{t("admin.showcase.title")}</h2>
        <p className="admin-chart-description">{t("admin.showcase.description")}</p>
        {groups.length === 0
          ? <p className="admin-empty">{t("admin.showcase.noGroups")}</p>
          : <ul style={{ display: "grid", gap: 10, margin: "16px 0 0", padding: 0, listStyle: "none" }}>
            {groups.map((group) => {
              const isSelected = selected?.id === group.id;
              return (
                <li key={group.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    className="ghost-button"
                    aria-pressed={isSelected}
                    disabled={busy}
                    onClick={() => setSelectedId(group.id)}
                    style={isSelected ? { borderColor: "var(--foreground)", color: "var(--foreground)" } : undefined}
                  >
                    {group.name}
                  </button>
                  {group.isActive && <span className="admin-badge">{t("admin.showcase.active")}</span>}
                  <small style={{ color: "var(--muted)" }}>{t("admin.showcase.itemCount", { n: formatCount(group.items.length) })}</small>
                  {!group.isActive && <button type="button" className="ghost-button" disabled={busy} onClick={() => { void mutate("set_active", { id: group.id }); }}>{t("admin.showcase.setActive")}</button>}
                  <button type="button" className="ghost-button admin-danger" disabled={busy} onClick={() => handleDeleteGroup(group.id, group.name)}>{t("admin.showcase.delete")}</button>
                </li>
              );
            })}
          </ul>}
        <div className="admin-moderation" style={{ marginTop: 16 }}>
          <label>
            <span>{t("admin.showcase.groupName")}</span>
            <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder={t("admin.showcase.groupName")} maxLength={80} disabled={busy} />
          </label>
          <button type="button" className="tactical-button" disabled={busy || !newGroupName.trim()} onClick={handleCreateGroup}>{t("admin.showcase.newGroup")}</button>
        </div>
      </section>
      {selected && (
        <ShowcaseGroupEditor
          key={selected.id}
          group={selected}
          t={t}
          busy={busy}
          onMutate={mutate}
          onValidationError={(messageKey) => setError(`${t("admin.error.save")}: ${t(messageKey)}`)}
        />
      )}
    </div>
  );
}

export default ShowcasePanel;
export { ShowcasePanel };

function ShowcaseGroupEditor({ group, t, busy, onMutate, onValidationError }: {
  group: ShowcaseGroup;
  t: T;
  busy: boolean;
  onMutate: (action: string, extra: Record<string, unknown>) => Promise<boolean>;
  onValidationError: (messageKey: string) => void;
}) {
  const [addAid, setAddAid] = useState("");
  const [addNickname, setAddNickname] = useState("");
  const [renameValue, setRenameValue] = useState(group.name);

  function handleRename() {
    const name = renameValue.trim();
    if (!name) {
      onValidationError("admin.showcase.invalidName");
      return;
    }
    if (name === group.name) return;
    void onMutate("rename_group", { id: group.id, name });
  }

  function handleAdd() {
    const aid = Number(addAid.trim());
    if (!Number.isSafeInteger(aid) || aid <= 0) {
      onValidationError("admin.showcase.invalidAid");
      return;
    }
    const nickname = addNickname.trim();
    void onMutate("add_item", { groupId: group.id, aid, nickname: nickname ? nickname : null }).then((saved) => {
      if (saved) { setAddAid(""); setAddNickname(""); }
    });
  }

  function handleMove(aid: number, direction: -1 | 1) {
    const aids = group.items.map((item) => item.aid);
    const index = aids.indexOf(aid);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= aids.length) return;
    [aids[index], aids[target]] = [aids[target], aids[index]];
    void onMutate("reorder", { groupId: group.id, aids });
  }

  return (
    <section className="data-panel admin-panel" aria-label={group.name}>
      <h2 className="section-heading">{group.name}</h2>
      <p className="admin-chart-description">{t("admin.showcase.items")}</p>
      <div className="admin-moderation" style={{ marginTop: 12 }}>
        <label>
          <span>{t("admin.showcase.groupName")}</span>
          <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={80} disabled={busy} />
        </label>
        <button type="button" className="ghost-button" disabled={busy || !renameValue.trim() || renameValue.trim() === group.name} onClick={handleRename}>{t("admin.showcase.rename")}</button>
      </div>
      <div className="admin-moderation" style={{ marginTop: 12 }}>
        <label>
          <span>{t("admin.showcase.aid")}</span>
          <input value={addAid} onChange={(event) => setAddAid(event.target.value)} inputMode="numeric" placeholder={t("admin.showcase.aid")} disabled={busy} />
        </label>
        <label>
          <span>{t("admin.showcase.nickname")}</span>
          <input value={addNickname} onChange={(event) => setAddNickname(event.target.value)} maxLength={64} placeholder={t("admin.showcase.nickname")} disabled={busy} />
        </label>
        <button type="button" className="tactical-button" disabled={busy || !addAid.trim()} onClick={handleAdd}>{t("admin.showcase.add")}</button>
      </div>
      {group.items.length === 0
        ? <p className="admin-empty">{t("admin.showcase.empty")}</p>
        : <ul style={{ display: "grid", gap: 12, margin: "16px 0 0", padding: 0, listStyle: "none" }}>
          {group.items.map((item, index) => (
            <ShowcaseItemRow
              key={item.aid}
              groupId={group.id}
              item={item}
              isFirst={index === 0}
              isLast={index === group.items.length - 1}
              t={t}
              busy={busy}
              onMove={handleMove}
              onMutate={onMutate}
            />
          ))}
        </ul>}
    </section>
  );
}

function ShowcaseItemRow({ groupId, item, isFirst, isLast, t, busy, onMove, onMutate }: {
  groupId: number;
  item: ShowcaseItem;
  isFirst: boolean;
  isLast: boolean;
  t: T;
  busy: boolean;
  onMove: (aid: number, direction: -1 | 1) => void;
  onMutate: (action: string, extra: Record<string, unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(item.nickname ?? "");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(item.nickname ?? "");
  }, [item.nickname, editing]);

  const dirty = draft.trim() !== (item.nickname ?? "");

  function handleSaveNickname() {
    const nickname = draft.trim();
    void onMutate("update_item", { groupId, aid: item.aid, nickname: nickname ? nickname : null }).then((saved) => {
      if (saved) setEditing(false);
    });
  }

  return (
    <li style={{ borderTop: "1px solid var(--card-border)", paddingTop: 12, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{t("admin.showcase.aid")} {item.aid}</strong>
        <Link className="admin-account__profile-link" href={`/player/regular/${item.aid}`} prefetch={false}>{t("admin.showcase.openProfile")}</Link>
        <span className="admin-badge">{item.enabled ? t("admin.showcase.enabled") : t("admin.showcase.disabled")}</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: ".76rem", color: "var(--muted-strong)" }}>
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={busy}
            onChange={(event) => { void onMutate("update_item", { groupId, aid: item.aid, enabled: event.target.checked }); }}
          />
          {t("admin.showcase.enable")}
        </label>
        <span style={{ display: "inline-flex", gap: 6, marginLeft: "auto" }}>
          <button type="button" className="ghost-button" aria-label={t("admin.showcase.up")} disabled={busy || isFirst} onClick={() => onMove(item.aid, -1)}>↑</button>
          <button type="button" className="ghost-button" aria-label={t("admin.showcase.down")} disabled={busy || isLast} onClick={() => onMove(item.aid, 1)}>↓</button>
          <button type="button" className="ghost-button admin-danger" disabled={busy} onClick={() => { void onMutate("remove_item", { groupId, aid: item.aid }); }}>{t("admin.showcase.remove")}</button>
        </span>
      </div>
      <div className="admin-moderation">
        <label>
          <span>{t("admin.showcase.nickname")}</span>
          <input value={draft} onChange={(event) => { setDraft(event.target.value); setEditing(true); }} maxLength={64} placeholder={t("admin.showcase.nickname")} disabled={busy} />
        </label>
        {dirty && <button type="button" className="ghost-button" disabled={busy} onClick={handleSaveNickname}>{t("admin.showcase.saveNickname")}</button>}
      </div>
    </li>
  );
}

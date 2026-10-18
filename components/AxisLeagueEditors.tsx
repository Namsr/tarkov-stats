"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

export default function AxisLeagueEditors() {
  const { t } = useI18n();
  const [editors, setEditors] = useState<{ subject: string; name: string | null }[] | null>(null);
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/axis-league/editors", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.editors)) throw new Error("Unavailable");
      if (!controller.signal.aborted) { setEditors(body.editors); setError(""); }
    }).catch(() => { if (!controller.signal.aborted) setError("admin.error.load"); });
    return () => controller.abort();
  }, [retry]);
  async function change(value: string, enabled: boolean) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/axis-league/editors", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: value, enabled }), signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok || !body.ok || !Array.isArray(body.editors)) throw new Error("Could not save");
      setEditors(body.editors); if (enabled) setSubject("");
    } catch { setError("admin.error.save"); }
    finally { setBusy(false); }
  }
  return <section className="axis-editor-access" aria-label={t("axis.editor.heading")}>
    <h3 className="section-heading">{t("axis.editor.heading")}</h3>
    <p className="admin-chart-description">{t("axis.editor.description")}</p>
    <form className="admin-moderation" onSubmit={(event) => { event.preventDefault(); void change(subject.trim(), true); }}>
      <label><span>{t("axis.editor.subject")}</span><input value={subject} onChange={(event) => setSubject(event.target.value)}
        required pattern="[A-Za-z0-9_-]{1,128}" maxLength={128} autoComplete="off" disabled={busy || editors === null} /></label>
      <button type="submit" className="ghost-button" disabled={busy || editors === null || !subject.trim()}>{t("axis.editor.grant")}</button>
    </form>
    {error && <p className="admin-notice" role="status">{t(error)} <button type="button" disabled={busy} className="ghost-button" onClick={() => setRetry((value) => value + 1)}>{t("admin.retry")}</button></p>}
    {editors === null && !error && <p role="status">{t("common.loading")}</p>}
    {editors?.length === 0 && <p className="axis-editor-empty">{t("axis.editor.empty")}</p>}
    {!!editors?.length && <ul className="axis-editor-list">{editors.map((editor) => <li key={editor.subject}><div className="axis-editor-identity"><strong>{editor.name ?? t("axis.editor.namePending")}</strong><code>{editor.subject}</code></div>
      <button type="button" className="ghost-button" disabled={busy} aria-label={t("axis.editor.revokeUser", { id: editor.name ? `${editor.name} (${editor.subject})` : editor.subject })} onClick={() => void change(editor.subject, false)}>{t("axis.editor.revoke")}</button>
    </li>)}</ul>}
  </section>;
}

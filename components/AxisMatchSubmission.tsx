"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AxisMatchPhoto, { type AxisMatchPhotoHandle } from "@/components/AxisMatchPhoto";
import type { AxisOcrImage } from "@/lib/axis-ocr";
import { useI18n } from "@/lib/i18n/context";

/** Players send only image bytes. The server recognizes and saves the result. */
export default function AxisMatchSubmission({ matchNumber, onSaved }: { matchNumber: number; onSaved: () => void }) {
  const { t } = useI18n();
  const photo = useRef<AxisMatchPhotoHandle>(null);
  const [image, setImage] = useState<AxisOcrImage | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const [version, setVersion] = useState(0);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  const imageChanged = useCallback((next: AxisOcrImage | null) => {
    setImage(current => current?.key === next?.key ? current : next);
  }, []);

  useEffect(() => {
    if (!image?.isNew) return;
    const change = photo.current?.getChange();
    if (!change || !change.data) return;
    const controller = new AbortController();
    setBusy(true); setMessage("");
    async function submit() {
      try {
        const response = await fetch("/api/axis-league/match-submission", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matchNumber, photo: change }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        });
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (response.status === 409) {
          setMessage("axis.submission.conflict"); setImage(null); setVersion(value => value + 1);
          onSavedRef.current();
        } else if (!response.ok || body.ok !== true || body.matchNumber !== matchNumber) {
          setMessage(response.status === 413 ? "axis.photo.tooLarge"
            : response.status === 401 || response.status === 403 ? "axis.submission.denied"
            : response.status === 422 ? "axis.submission.mismatch" : "axis.submission.error");
        } else {
          setMessage("axis.submission.saved"); setImage(null); setVersion(value => value + 1);
          onSavedRef.current();
        }
      } catch { if (!controller.signal.aborted) setMessage("axis.submission.error"); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void submit();
    return () => controller.abort();
  }, [image, matchNumber, retry]);

  return <>
    {editing && <section className="axis-match-edit-form" aria-label={t("axis.submission.title", { n: matchNumber })}
      onPaste={event => photo.current?.paste(event)} aria-busy={busy}>
      <AxisMatchPhoto key={`${matchNumber}:${version}`} ref={photo} matchNumber={matchNumber} busy={busy}
        uploadOnly onImageChange={imageChanged} />
      {(busy || message) && <p className="admin-notice" role="status" aria-live="polite">{t(busy ? "axis.submission.running" : message)}</p>}
      {!busy && message === "axis.submission.error" && <button type="button" className="ghost-button" onClick={() => setRetry(value => value + 1)}>{t("admin.retry")}</button>}
    </section>}
    <div className="axis-kda-editor"><button type="button" className="ghost-button" disabled={busy} aria-expanded={editing}
      onClick={() => { setImage(null); setMessage(""); setEditing(value => !value); }}>{t(editing ? "axis.kda.cancel" : "axis.kda.edit")}</button></div>
  </>;
}

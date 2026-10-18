"use client";

import { useEffect, useId, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/context";
import { AXIS_PHOTO_MAX_BYTES, AXIS_PHOTO_MAX_PIXELS, AXIS_PHOTO_TYPES, axisPhotoUrl, type AxisMatchPhoto } from "@/lib/axis-match-photo";

type PhotoPreview = { src: string; width: number; height: number };

function PhotoViewer({ image, matchNumber, onClose }: { image: PhotoPreview; matchNumber: number; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const fit = Math.min(1, size.width / image.width, size.height / image.height);
  const maxZoom = 4 / fit;
  const width = Math.max(1, Math.round(image.width * fit * zoom));
  const height = Math.max(1, Math.round(image.height * fit * zoom));
  useEffect(() => {
    const element = dialog.current!, area = viewport.current!;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    const observer = new ResizeObserver(() => setSize({ width: area.clientWidth, height: area.clientHeight }));
    observer.observe(area);
    return () => { observer.disconnect(); element.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  function changeZoom(next: number) {
    const area = viewport.current;
    if (area) {
      const ratio = next / zoom;
      const x = (area.scrollLeft + area.clientWidth / 2) * ratio - area.clientWidth / 2;
      const y = (area.scrollTop + area.clientHeight / 2) * ratio - area.clientHeight / 2;
      requestAnimationFrame(() => { area.scrollLeft = Math.max(0, x); area.scrollTop = Math.max(0, y); });
    }
    setZoom(next);
  }
  return createPortal(<dialog ref={dialog} className="axis-photo-dialog" aria-labelledby={titleId} onClose={() => { if (!dialog.current?.open) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="axis-photo-dialog__content">
      <div className="axis-photo-dialog__header"><h2 id={titleId}>{t("axis.photo.title", { n: matchNumber })}</h2>
        <button type="button" className="ghost-button" onClick={() => dialog.current?.close()}>{t("common.close")}</button></div>
      <div className="axis-photo-tools" role="group" aria-label={t("axis.photo.zoom")}>
        <button type="button" className="ghost-button" aria-label={t("axis.photo.zoomOut")} disabled={zoom <= 0.5} onClick={() => changeZoom(Math.max(0.5, zoom / 1.5))}><span aria-hidden="true">−</span></button>
        <output aria-live="polite" aria-label={t("axis.photo.zoom")}>{Math.round(fit * zoom * 100)}%</output>
        <button type="button" className="ghost-button" aria-label={t("axis.photo.zoomIn")} disabled={zoom >= maxZoom} onClick={() => changeZoom(Math.min(maxZoom, zoom * 1.5))}><span aria-hidden="true">+</span></button>
        <button type="button" className="ghost-button" onClick={() => { changeZoom(1); viewport.current?.scrollTo(0, 0); }}>{t("axis.photo.fit")}</button>
      </div>
      <div ref={viewport} className="axis-photo-viewport" tabIndex={0} role="region" aria-label={t("axis.photo.pan")}>
        {failed ? <p className="admin-notice" role="alert">{t("axis.photo.loadError")}</p> :
          <div className="axis-photo-canvas" style={{ width: Math.max(size.width, width), height: Math.max(size.height, height) }}>
            {/* Original pixels are served directly; optimization would blur small score text. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.src} alt={t("axis.photo.alt", { n: matchNumber })} width={width} height={height} draggable={false} onError={() => setFailed(true)} />
          </div>}
      </div>
    </div>
  </dialog>, document.body);
}

/** Mounted only inside the authorized match statistics editor. */
export default function AxisMatchPhoto({ matchNumber }: { matchNumber: number }) {
  const { t } = useI18n();
  const [photo, setPhoto] = useState<AxisMatchPhoto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const saving = useRef(false);
  const [draft, setDraft] = useState<PhotoPreview | null>();
  const [expected, setExpected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const [viewer, setViewer] = useState<PhotoPreview | null>(null);
  const preview = draft === undefined ? photo ? { ...photo, src: axisPhotoUrl(matchNumber, photo.revision) } : null : draft;
  useEffect(() => () => { selection.current++; }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/axis-league/match-photo?match=${matchNumber}&meta=1`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error("Photo unavailable");
        const body = await response.json();
        if (body.matchNumber !== matchNumber || body.photo !== null && (!/^[a-f0-9]{64}$/.test(body.photo?.revision) || !(body.photo?.width > 0) || !(body.photo?.height > 0))) throw new Error("Invalid photo metadata");
        if (!controller.signal.aborted) { setPhoto(body.photo); setLoaded(true); setLoadFailed(false); }
      } catch { if (!controller.signal.aborted) setLoadFailed(true); }
    }
    void load();
    return () => controller.abort();
  }, [matchNumber, retry]);

  async function select(file: File) {
    if (!loaded || loadFailed || saving.current) return;
    const version = ++selection.current;
    setMessage(""); setReading(false);
    if (!AXIS_PHOTO_TYPES.includes(file.type)) { setMessage(t("axis.photo.invalid")); return; }
    if (!file.size || file.size > AXIS_PHOTO_MAX_BYTES) { setMessage(t("axis.photo.tooLarge")); return; }
    setReading(true);
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const image = new Image(); image.src = src; await image.decode();
      if (image.naturalWidth * image.naturalHeight > AXIS_PHOTO_MAX_PIXELS) throw new Error("Image too large");
      if (version !== selection.current) return;
      setExpected(photo?.revision ?? null); setConflict(false);
      setDraft({ src, width: image.naturalWidth, height: image.naturalHeight });
    } catch { if (version === selection.current) setMessage(t("axis.photo.invalid")); }
    finally { if (version === selection.current) setReading(false); }
  }
  function paste(event: ClipboardEvent) {
    if (!loaded || loadFailed || busy || reading) return;
    const file = Array.from(event.clipboardData.files).find(file => file.type.startsWith("image/"));
    if (file) { event.preventDefault(); void select(file); }
  }
  async function save() {
    if (draft === undefined || saving.current || reading || conflict || !loaded || loadFailed) return;
    saving.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/axis-league/match-photo", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchNumber, expected, data: draft === null ? null : draft.src.slice(draft.src.indexOf(",") + 1) }), signal: AbortSignal.timeout(30_000) });
      if (response.status === 409) { setConflict(true); setRetry(value => value + 1); setMessage(t("axis.photo.conflict")); return; }
      if (!response.ok) { setMessage(t(response.status === 413 ? "axis.photo.tooLarge" : response.status === 400 ? "axis.photo.invalid" : "admin.error.save")); return; }
      const body = await response.json();
      if (!body.ok || body.matchNumber !== matchNumber || body.photo !== null && (!/^[a-f0-9]{64}$/.test(body.photo?.revision) || !(body.photo?.width > 0) || !(body.photo?.height > 0))) throw new Error("Invalid photo response");
      setPhoto(body.photo); setDraft(undefined); setMessage(t("admin.saved"));
    } catch { setMessage(t("admin.error.save")); }
    finally { saving.current = false; setBusy(false); }
  }
  if (!loaded || loadFailed) return <section className="axis-match-photo" aria-label={t("axis.photo.title", { n: matchNumber })}>
    <p role="status">{t(loadFailed ? "axis.photo.loadError" : "common.loading")}</p>
    {loadFailed && <button type="button" className="ghost-button" onClick={() => { setLoadFailed(false); setRetry(value => value + 1); }}>{t("admin.retry")}</button>}
  </section>;
  return <section className="axis-match-photo" aria-label={t("axis.photo.title", { n: matchNumber })} onPaste={paste}>
    <h3>{t("axis.photo.label")}</h3>
    {preview && <button type="button" className="axis-photo-thumbnail" onClick={() => setViewer(preview)} aria-label={t("axis.photo.open", { n: matchNumber })}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={preview.src} alt={t("axis.photo.alt", { n: matchNumber })} loading="lazy" width={preview.width} height={preview.height} />
      <span>{t("axis.photo.view")}</span>
    </button>}
    <div className="axis-photo-upload">
        <button type="button" className="axis-photo-paste" disabled={busy || reading} aria-keyshortcuts="Control+V Meta+V" onClick={(event) => event.currentTarget.focus()}>{t("axis.photo.paste")}</button>
        <button type="button" className="ghost-button" disabled={busy || reading} onClick={() => input.current?.click()}>{t("axis.photo.choose")}</button>
        <input ref={input} type="file" hidden accept={AXIS_PHOTO_TYPES.join(",")} aria-label={t("axis.photo.choose")} onChange={(event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void select(file);
        }} />
        {preview && <button type="button" className="ghost-button" disabled={busy || reading} onClick={() => { setExpected(photo?.revision ?? null); setDraft(null); setConflict(false); setMessage(""); }}>{t("axis.photo.remove")}</button>}
      </div>
      <p className="axis-kda-hint">{t("axis.photo.hint")}</p>
      {draft !== undefined && <div className="axis-kda-actions">
        <button type="button" className="tactical-button" disabled={busy || reading || conflict} onClick={() => void save()}>{t(busy ? "common.loading" : "axis.photo.save")}</button>
        <button type="button" className="ghost-button" disabled={busy} onClick={() => { selection.current++; setReading(false); setDraft(undefined); setConflict(false); setMessage(""); }}>{t("axis.kda.cancel")}</button>
      </div>}
      {(reading || message) && <p className="admin-notice" role="status">{reading ? t("common.loading") : message}</p>}
    {viewer && <PhotoViewer image={viewer} matchNumber={matchNumber} onClose={() => setViewer(null)} />}
  </section>;
}

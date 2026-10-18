"use client";

import { useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/context";
import { AXIS_PHOTO_MAX_BYTES, AXIS_PHOTO_MAX_PIXELS, AXIS_PHOTO_TYPES, axisPhotoUrl, type AxisMatchPhoto, type AxisPhotoUpload } from "@/lib/axis-match-photo";

export interface AxisMatchPhotoHandle {
  paste: (event: ClipboardEvent) => void;
  getChange: () => AxisPhotoUpload | undefined | false;
  conflict: () => void;
}

type PhotoPreview = { src: string; width: number; height: number };

function PhotoViewer({ image, matchNumber, onClose }: { image: PhotoPreview; matchNumber: number; onClose: () => void }) {
  const { t } = useI18n();
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
  return createPortal(<dialog ref={dialog} className="axis-photo-dialog" aria-label={t("axis.photo.title", { n: matchNumber })} onClose={() => { if (!dialog.current?.open) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="axis-photo-dialog__content">
      <div className="axis-photo-dialog__header"><button type="button" className="ghost-button" aria-label={t("common.close")} onClick={() => dialog.current?.close()}><span aria-hidden="true">×</span></button></div>
      <div className="axis-photo-tools" role="group" aria-label={t("axis.photo.zoom")}>
        <button type="button" className="ghost-button" aria-label={t("axis.photo.zoomOut")} disabled={zoom <= 0.5} onClick={() => changeZoom(Math.max(0.5, zoom / 1.5))}><span aria-hidden="true">−</span></button>
        <output aria-live="polite" aria-label={t("axis.photo.zoom")}>{Math.round(fit * zoom * 100)}%</output>
        <button type="button" className="ghost-button" aria-label={t("axis.photo.zoomIn")} disabled={zoom >= maxZoom} onClick={() => changeZoom(Math.min(maxZoom, zoom * 1.5))}><span aria-hidden="true">+</span></button>
        <button type="button" className="ghost-button" aria-label={t("axis.photo.fit")} title={t("axis.photo.fit")} onClick={() => { changeZoom(1); viewport.current?.scrollTo(0, 0); }}><span aria-hidden="true">↔</span></button>
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
export default function AxisMatchPhoto({ matchNumber, busy, ref }: { matchNumber: number; busy: boolean; ref: Ref<AxisMatchPhotoHandle> }) {
  const { t } = useI18n();
  const [photo, setPhoto] = useState<AxisMatchPhoto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const selection = useRef(0);
  const metadataRequest = useRef<Promise<AxisMatchPhoto | null | undefined>>(Promise.resolve(undefined));
  const [draft, setDraft] = useState<PhotoPreview | null>();
  const [expected, setExpected] = useState<string | null>(null);
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
        if (!controller.signal.aborted) { setPhoto(body.photo); setLoaded(true); setLoadFailed(false); return body.photo as AxisMatchPhoto | null; }
      } catch { if (!controller.signal.aborted) setLoadFailed(true); }
      return undefined;
    }
    metadataRequest.current = load();
    return () => controller.abort();
  }, [matchNumber, retry]);

  async function select(file: File) {
    if (loadFailed || busy) return;
    const version = ++selection.current;
    setMessage(""); setReading(false);
    if (!AXIS_PHOTO_TYPES.includes(file.type)) { setMessage(t("axis.photo.invalid")); return; }
    if (!file.size || file.size > AXIS_PHOTO_MAX_BYTES) { setMessage(t("axis.photo.tooLarge")); return; }
    setReading(true);
    try {
      const currentPhoto = await metadataRequest.current;
      if (currentPhoto === undefined || version !== selection.current) return;
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const image = new Image(); image.src = src; await image.decode();
      if (image.naturalWidth * image.naturalHeight > AXIS_PHOTO_MAX_PIXELS) throw new Error("Image too large");
      if (version !== selection.current) return;
      setExpected(currentPhoto?.revision ?? null); setConflict(false);
      setDraft({ src, width: image.naturalWidth, height: image.naturalHeight });
    } catch { if (version === selection.current) setMessage(t("axis.photo.invalid")); }
    finally { if (version === selection.current) setReading(false); }
  }
  function paste(event: ClipboardEvent) {
    if (loadFailed || busy || reading) return;
    const file = Array.from(event.clipboardData.files).find(file => file.type.startsWith("image/"));
    if (file) { event.preventDefault(); void select(file); }
  }
  useImperativeHandle(ref, () => ({
    paste,
    getChange() {
      if (reading || conflict) return false;
      return draft === undefined ? undefined : { expected, data: draft === null ? null : draft.src.slice(draft.src.indexOf(",") + 1) };
    },
    conflict() { setConflict(true); setRetry(value => value + 1); setMessage(t("axis.kda.conflict")); },
  }));
  return <section className="axis-match-photo" aria-label={t("axis.photo.title", { n: matchNumber })}>
    <div className="axis-photo-paste" tabIndex={0} role="group" aria-label={t("axis.photo.pasteHint")}>
      <h4>{t("axis.photo.heading")}</h4>
      <p>{t("axis.photo.pasteHint")}</p>
    </div>
    {!loaded && !loadFailed && <p role="status">{t("common.loading")}</p>}
    {loadFailed && <>
      <p role="status">{t("axis.photo.loadError")}</p>
      <button type="button" className="ghost-button" onClick={() => { setLoadFailed(false); setRetry(value => value + 1); }}>{t("admin.retry")}</button>
    </>}
    {preview && <button type="button" className="axis-photo-thumbnail" onClick={() => setViewer(preview)} aria-label={t("axis.photo.open", { n: matchNumber })}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={preview.src} alt={t("axis.photo.alt", { n: matchNumber })} loading="lazy" width={preview.width} height={preview.height} />
    </button>}
    {preview && <button type="button" className="axis-photo-remove" disabled={busy || reading} aria-label={t("axis.photo.remove")}
      onClick={() => { setExpected(photo?.revision ?? null); setDraft(null); setConflict(false); setMessage(""); }}><span aria-hidden="true">×</span></button>}
    {(reading || message) && <p className="admin-notice" role="status">{reading ? t("common.loading") : message}</p>}
    {viewer && <PhotoViewer image={viewer} matchNumber={matchNumber} onClose={() => setViewer(null)} />}
  </section>;
}

"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { browserPage, resourceSamples, type BrowserMetric, type BrowserSample } from "@/lib/observability/browser-performance";

export default function PerformanceBeacon() {
  const pathname = usePathname();
  const currentPath = useRef(pathname);
  useEffect(() => { currentPath.current = pathname; }, [pathname]);

  useEffect(() => {
    if (navigator.doNotTrack === "1" || !["tarkovstats.ru", "www.tarkovstats.ru", "tarkovstats.online", "www.tarkovstats.online"].includes(location.hostname)) return;
    const initialPath = browserPage(location.pathname);
    const pending = new Map<string, BrowserSample[]>();
    const observers: Array<{ observer: PerformanceObserver; callback: (entries: PerformanceEntry[]) => void }> = [];
    let queued = 0;
    let captured = 0;
    let lcp: number | null = null;
    let lcpSent = false;
    let navigationSent = false;
    let batches = 0;
    let windowStarted = performance.now();

    function add(sample: BrowserSample, path = browserPage(currentPath.current ?? "")) {
      const essential = !sample.metric.startsWith("api_") && sample.metric !== "long_task";
      if (!path || queued >= (essential ? 100 : 80) || captured >= (essential ? 400 : 380)
        || !Number.isFinite(sample.value) || sample.value < 0 || sample.value > 300_000) return;
      const samples = pending.get(path) ?? [];
      samples.push(sample);
      pending.set(path, samples);
      queued++;
      captured++;
    }
    function metric(name: BrowserMetric, value: number, path = initialPath) {
      add({ metric: name, value, endpoint: null }, path);
    }
    function navigation() {
      if (navigationSent || !initialPath) return;
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!entry || entry.loadEventEnd <= 0) return;
      navigationSent = true;
      metric("ttfb", entry.responseStart - entry.startTime);
      metric("dns", entry.domainLookupEnd - entry.domainLookupStart);
      metric("connect", entry.connectEnd - entry.connectStart);
      if (entry.secureConnectionStart > 0) metric("tls", entry.connectEnd - entry.secureConnectionStart);
      metric("download", entry.responseEnd - entry.responseStart);
      metric("dom_interactive", entry.domInteractive - entry.startTime);
      metric("load", entry.loadEventEnd - entry.startTime);
    }
    function flush(final = false) {
      if (final) for (const { observer, callback } of observers) callback(observer.takeRecords());
      navigation();
      if (final && !lcpSent && lcp !== null) { metric("lcp", lcp); lcpSent = true; }
      if (performance.now() - windowStarted >= 60_000) { batches = 0; windowStarted = performance.now(); }
      for (const [path, samples] of pending) {
        while (samples.length && batches < 5) {
          const batch = samples.splice(0, 20);
          queued -= batch.length;
          batches++;
          const payload = JSON.stringify({ path, samples: batch });
          try {
            if (navigator.sendBeacon?.("/api/performance", new Blob([payload], { type: "application/json" }))) continue;
            void fetch("/api/performance", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
              keepalive: true, credentials: "same-origin" }).catch(() => {});
          } catch { /* Monitoring must remain silent. */ }
        }
        if (!samples.length) pending.delete(path);
      }
    }
    function observe(type: string, callback: (entries: PerformanceEntry[]) => void) {
      if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      try {
        const observer = new PerformanceObserver((list) => callback(list.getEntries()));
        observer.observe({ type, buffered: true });
        observers.push({ observer, callback });
      } catch { /* Unsupported metrics remain absent, not zero. */ }
    }
    metric("client_ready", performance.now());
    observe("paint", (entries) => { for (const entry of entries) if (entry.name === "first-contentful-paint") metric("fcp", entry.startTime); });
    observe("largest-contentful-paint", (entries) => { lcp = entries.at(-1)?.startTime ?? lcp; });
    observe("longtask", (entries) => { for (const entry of entries) metric("long_task", entry.duration, browserPage(currentPath.current ?? "")); });
    observe("resource", (entries) => {
      for (const entry of entries) for (const sample of resourceSamples(entry as PerformanceResourceTiming, location.origin)) add(sample);
    });
    const timer = setInterval(() => flush(), 15_000);
    const onHidden = () => { if (document.visibilityState === "hidden") flush(true); };
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(timer);
      for (const { observer } of observers) observer.disconnect();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);
  return null;
}

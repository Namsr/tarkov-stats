import type { AdminReportState } from "./reports.ts";
import type { AdminReport } from "./report-worker.ts";

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Only poll while this particular load owns the screen. Filters and navigation
// abort both the HTTP request and its wait; the server keeps its bounded job.
export async function loadAdminReport(params: URLSearchParams, options: {
  signal: AbortSignal;
  onState: (state: AdminReportState) => void;
}): Promise<AdminReport> {
  const until = Date.now() + 130_000;
  let refresh = true;
  while (Date.now() < until) {
    options.signal.throwIfAborted();
    const query = new URLSearchParams(params);
    if (refresh) query.set("refresh", "1");
    const response = await fetch(`/api/admin/health-report?${query}`, { cache: "no-store", signal: options.signal });
    if (!response.ok) throw new Error(String(response.status));
    const state = await response.json() as AdminReportState;
    options.signal.throwIfAborted();
    options.onState(state);
    if (state.status === "ready" && state.report) return state.report;
    if (state.status !== "running") throw new Error("admin_report_unavailable");
    refresh = false;
    await pause(options.signal);
  }
  throw new Error("admin_report_timeout");
}

import { computeAdminReportInBackground, type AdminReport, type AdminReportJob } from "./report-worker.ts";
import type { AdminDomain, AdminPeriod } from "./types.ts";

export type AdminReportState = {
  status: "running" | "ready" | "error";
  startedAt: number;
  report: AdminReport | null;
};

// Keep only three filter selections; never evict active work or start duplicate
// jobs when a poll, refresh, or second browser reaches the same selection.
export class AdminReports {
  private entries = new Map<string, AdminReportState>();
  private compute: (job: AdminReportJob) => Promise<AdminReport>;
  constructor(compute: (job: AdminReportJob) => Promise<AdminReport> = computeAdminReportInBackground) {
    this.compute = compute;
  }

  read(period: AdminPeriod, domain: AdminDomain, refresh = false): AdminReportState {
    const key = `${period}:${domain}`;
    const previous = this.entries.get(key);
    if (previous && (previous.status === "running" || !refresh)) return previous;
    if (!previous && this.entries.size >= 3) {
      const oldest = [...this.entries].find(([, entry]) => entry.status !== "running");
      if (!oldest) return { status: "error", startedAt: Date.now(), report: null };
      this.entries.delete(oldest[0]);
    }
    const entry: AdminReportState = { status: "running", startedAt: Date.now(), report: previous?.report ?? null };
    this.entries.set(key, entry);
    void this.compute({ period, domain, now: entry.startedAt }).then((report) => {
      entry.report = report;
      entry.status = "ready";
    }, () => { entry.status = "error"; });
    return entry;
  }
}

export const adminReports = new AdminReports();

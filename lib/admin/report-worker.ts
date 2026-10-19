import { ComputeWorker } from "../compute-worker.ts";
import type { AdminDomain, AdminPeriod } from "./types.ts";
import type { computeAdminReport } from "./report-compute.ts";

export type AdminReportJob = { period: AdminPeriod; domain: AdminDomain; now: number };
export type AdminReport = Awaited<ReturnType<typeof computeAdminReport>>;

export class AdminReportWorker extends ComputeWorker<[AdminReportJob], AdminReport> {
  constructor(options: { entry?: string; timeoutMs?: number; totalTimeoutMs?: number; maxPending?: number } = {}) {
    super({ name: "Admin report", entry: "scripts/compute-admin-report.mjs", timeoutMs: 90_000,
      totalTimeoutMs: 120_000, maxPending: 2, maxOldSpaceMb: 128, ...options });
  }
}

const worker = new AdminReportWorker();
export function computeAdminReportInBackground(job: AdminReportJob): Promise<AdminReport> {
  return worker.compute(job);
}

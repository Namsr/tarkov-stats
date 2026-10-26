// Read-only local benchmark diagnostics. Sampling happens outside timed requests.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function parentResources() {
  const usage = process.resourceUsage();
  return { userCpuMs: usage.userCPUTime / 1000, systemCpuMs: usage.systemCPUTime / 1000,
    workingSetBytes: process.memoryUsage.rss(), peakRssBytes: usage.maxRSS * 1024 };
}

function windowsChildren() {
  // PID is supplied by Node, never by an argument or shell interpolation.
  const source = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | ` +
    `Where-Object { $_.Name -in @('node.exe','tarkov-cohort-worker.exe') } | ForEach-Object { ` +
    `$taskProcess=Get-Process -Id $_.ProcessId -ErrorAction Stop; [pscustomobject]@{pid=$taskProcess.Id;name=$taskProcess.ProcessName;` +
    `cpuMs=$taskProcess.TotalProcessorTime.TotalMilliseconds;workingSetBytes=$taskProcess.WorkingSet64;peakWorkingSetBytes=$taskProcess.PeakWorkingSet64} } | ConvertTo-Json -Compress`;
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const text = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", source],
    { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
  const value = text ? JSON.parse(text) : [];
  return Array.isArray(value) ? value : [value];
}

function linuxChildren() {
  const ids = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")
    .trim().split(/\s+/).filter(Boolean).map(Number);
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 5000 }).trim());
  if (!Number.isFinite(ticks) || ticks <= 0) throw new Error("clock_ticks_unavailable");
  return ids.flatMap((pid) => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    if (name !== "node" && !name.startsWith("tarkov-cohort")) return [];
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kib = (field) => {
      const match = status.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m"));
      if (!match) throw new Error("memory_counter_unavailable");
      return Number(match[1]) * 1024;
    };
    return [{ pid, name, cpuMs: (Number(fields[11]) + Number(fields[12])) * 1000 / ticks,
      workingSetBytes: kib("VmRSS"), peakWorkingSetBytes: kib("VmHWM") }];
  });
}

export function snapshotWorkerResources() {
  const parent = parentResources();
  try {
    if (!["win32", "linux"].includes(process.platform)) return { available: false, reason: "unsupported_platform", parent, children: [] };
    const children = process.platform === "win32" ? windowsChildren() : linuxChildren();
    return { available: children.length > 0, reason: children.length ? null : "no_worker", parent, children };
  } catch (error) {
    return { available: false, reason: error.code || "resource_read_failed", parent, children: [] };
  }
}

export function resourceDelta(before, after) {
  const sameWorkers = before.available && after.available && before.children.length === after.children.length &&
    after.children.every((child) => before.children.some((old) => old.pid === child.pid && old.name === child.name && child.cpuMs >= old.cpuMs));
  return { available: Boolean(sameWorkers), reason: sameWorkers ? null : "worker_counters_unavailable_or_restarted",
    workerCpuMs: sameWorkers ? after.children.reduce((sum, child) => sum + child.cpuMs - before.children.find((old) => old.pid === child.pid).cpuMs, 0) : null,
    workers: after.children.map(({ name, workingSetBytes, peakWorkingSetBytes }) => ({ name, workingSetBytes, peakWorkingSetBytes })),
    parentCpuMs: after.parent.userCpuMs + after.parent.systemCpuMs - before.parent.userCpuMs - before.parent.systemCpuMs,
    parentWorkingSetBytes: after.parent.workingSetBytes,
    parentLifetimePeakRssBytes: after.parent.peakRssBytes,
    scope: "Worker CPU delta covers warmup+miss+hit workloads after the cold request; child peak RSS is lifetime since spawn. Parent lifetime high-water values are cumulative across backends and not directly comparable. Sampling subprocess time is excluded from API latency samples." };
}

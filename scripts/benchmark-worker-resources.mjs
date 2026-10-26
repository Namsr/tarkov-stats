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

/** Cgroup v2 counters for the current process's group; never the host root by fallback. */
export function snapshotContainerResources() {
  const unavailable = (reason) => ({ available: false, reason, version: null, path: null,
    sampledAt: new Date().toISOString(), memory: null, cpu: null, memoryEvents: null });
  if (process.platform !== "linux") return unavailable("unsupported_platform");
  try {
    const membership = readFileSync("/proc/self/cgroup", "utf8").split("\n")
      .find((line) => line.startsWith("0::"));
    if (!membership) return unavailable("cgroup_v2_unavailable");
    const group = membership.slice(3).trim();
    const unescape = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").flatMap((line) => {
      const [left, right] = line.split(" - ");
      if (!right?.startsWith("cgroup2 ")) return [];
      const fields = left.split(" ");
      const root = unescape(fields[3]);
      const mount = unescape(fields[4]);
      return group === root || group.startsWith(root === "/" ? "/" : `${root}/`)
        ? [{ root, mount }] : [];
    }).sort((a, b) => b.root.length - a.root.length);
    if (!mounts.length) return unavailable("cgroup_v2_mount_unavailable");
    const { root, mount } = mounts[0];
    // Both paths come from procfs. Reject namespace-relative '..' instead of
    // walking outside the mounted hierarchy and accidentally reading a host group.
    if (!group.startsWith("/") || group.split("/").includes("..")) return unavailable("cgroup_path_unavailable");
    const suffix = root === "/" ? group.slice(1) : group.slice(root.length).replace(/^\//, "");
    const directory = join(mount, suffix);
    const missing = [];
    const text = (file) => {
      try { return readFileSync(join(directory, file), "utf8").trim(); }
      catch { missing.push(file); return null; }
    };
    const counter = (value, name) => {
      if (value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
      if (!missing.includes(name)) missing.push(name);
      return null;
    };
    const entries = (value) => new Map((value ?? "").split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/)));
    const current = counter(text("memory.current"), "memory.current");
    const peak = counter(text("memory.peak"), "memory.peak");
    const maximum = text("memory.max");
    const maxBytes = maximum === "max" ? null : counter(maximum, "memory.max");
    const swapMaximum = text("memory.swap.max");
    const swapMaxBytes = swapMaximum === "max" ? null : counter(swapMaximum, "memory.swap.max");
    const stats = entries(text("cpu.stat"));
    const cpuMax = text("cpu.max")?.split(/\s+/) ?? [];
    const events = entries(text("memory.events"));
    const memory = { currentBytes: current, peakBytes: peak, maxBytes,
      maxUnlimited: maximum === null ? null : maximum === "max", swapMaxBytes,
      swapUnlimited: swapMaximum === null ? null : swapMaximum === "max" };
    const cpu = { usageUs: counter(stats.get("usage_usec") ?? null, "cpu.stat.usage_usec"),
      userUs: counter(stats.get("user_usec") ?? null, "cpu.stat.user_usec"),
      systemUs: counter(stats.get("system_usec") ?? null, "cpu.stat.system_usec"),
      quotaUs: cpuMax[0] === "max" ? null : counter(cpuMax[0] ?? null, "cpu.max.quota"),
      periodUs: counter(cpuMax[1] ?? null, "cpu.max.period"),
      unlimited: cpuMax.length === 0 ? null : cpuMax[0] === "max" };
    const memoryEvents = { oomKill: counter(events.get("oom_kill") ?? null, "memory.events.oom_kill") };
    return { available: missing.length === 0, reason: missing.length ? "cgroup_counters_unavailable" : null,
      version: 2, path: directory, sampledAt: new Date().toISOString(), unavailableCounters: missing,
      memory, cpu, memoryEvents,
      scope: "Current cgroup lifetime counters, including all its processes and setup/cold/warm workloads. memory.peak is total charged cgroup memory, including page cache, not process RSS. CPU counters cover lifetime through this snapshot, not only timed API calls." };
  } catch (error) { return unavailable(error.code || "cgroup_resource_read_failed"); }
}

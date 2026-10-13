import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const round = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const counterDelta = (current, previous) => Number.isFinite(current) && Number.isFinite(previous) && current >= previous
  ? current - previous : null;

const runtimeKey = Symbol.for("tarkovstats.runtime-health");
export function runtimeHealthReport(from, to = Date.now()) {
  const samples = (globalThis[runtimeKey] ?? []).filter((event) => event.at >= from && event.at <= to);
  return { available: samples.length > 0, retentionSamples: 120, sampleCount: samples.length,
    latest: samples.at(-1) ?? null, samples };
}

export function parsePressure(source) {
  const result = {};
  for (const line of source.trim().split("\n")) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind !== "some" && kind !== "full") continue;
    const values = Object.fromEntries(fields.map((field) => field.split("=")));
    const avg10 = Number(values.avg10);
    const totalUs = Number(values.total);
    if (Number.isFinite(avg10) && avg10 >= 0 && Number.isFinite(totalUs) && totalUs >= 0) {
      result[kind] = { avg10Percent: avg10, totalUs };
    }
  }
  return Object.keys(result).length ? result : null;
}

export function parseSwap(source) {
  const counters = {};
  for (const line of source.split("\n")) {
    const [key, raw] = line.trim().split(/\s+/);
    if (key !== "pswpin" && key !== "pswpout") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) counters[key] = value;
  }
  return Number.isFinite(counters.pswpin) && Number.isFinite(counters.pswpout)
    ? { inPages: counters.pswpin, outPages: counters.pswpout } : null;
}

async function hostCounters() {
  // These /proc counters describe the host, not just this container. Missing
  // Linux files (or a denied read) are unavailable, never a zero-pressure claim.
  const files = await Promise.all(["pressure/cpu", "pressure/io", "pressure/memory", "vmstat"].map(
    (path) => readFile(`/proc/${path}`, "utf8").catch(() => ""),
  ));
  return { pressure: { cpu: parsePressure(files[0]), io: parsePressure(files[1]), memory: parsePressure(files[2]) }, swap: parseSwap(files[3]) };
}

export function startRuntimeHealth({ intervalMs = 60_000, logger = console.log } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previousAt = performance.now();
  let previousCpu = process.cpuUsage();
  let previousLoop = performance.eventLoopUtilization();
  let previousHostAt;
  let previousSwap;
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const now = performance.now();
      const cpu = process.cpuUsage();
      const loop = performance.eventLoopUtilization();
      const windowMs = now - previousAt;
      const cpuMs = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000;
      const event = {
        event: "runtime_health_v1", at: Date.now(), pid: process.pid, windowMs: round(windowMs),
        eventLoop: { p99Ms: delay.count ? round(delay.percentile(99) / 1e6) : null,
          maxMs: delay.count ? round(delay.max / 1e6) : null,
          utilization: round(performance.eventLoopUtilization(loop, previousLoop).utilization) },
        cpuMs: round(cpuMs), cpuPercent: round(cpuMs / windowMs * 100), memory: process.memoryUsage(),
      };
      previousAt = now;
      previousCpu = cpu;
      previousLoop = loop;
      delay.reset();
      const host = await hostCounters();
      const hostAt = performance.now();
      event.host = { at: Date.now(), pressure: host.pressure, swap: host.swap ? {
        ...host.swap, windowMs: previousHostAt === undefined ? null : round(hostAt - previousHostAt),
        inPagesDelta: counterDelta(host.swap.inPages, previousSwap?.inPages),
        outPagesDelta: counterDelta(host.swap.outPages, previousSwap?.outPages),
      } : null };
      previousHostAt = hostAt;
      previousSwap = host.swap;
      const history = globalThis[runtimeKey] ?? (globalThis[runtimeKey] = []);
      history.push(event);
      if (history.length > 120) history.shift();
      logger(JSON.stringify(event));
    } catch {
      // Observability must not crash the HTTP process or create retry/log floods.
    } finally {
      sampling = false;
    }
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); delay.disable(); };
}

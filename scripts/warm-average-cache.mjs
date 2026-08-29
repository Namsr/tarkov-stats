const baseUrl = (process.env.AVERAGE_WARM_BASE_URL || "http://web:3000").replace(/\/+$/, "");
const configuredInterval = Number(process.env.AVERAGE_WARM_INTERVAL_MS);
const intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
  ? Math.max(60_000, configuredInterval)
  : 25 * 60_000;
const retryDelayMs = 2_000;
const maxAttempts = 60;
const modes = ["regular", "pve"];
const arenaModes = ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
const statistics = ["trimmed_mean", "median"];
const periods = ["all", "90d"];
let running = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${path}`);
  }
  await response.arrayBuffer();
}

function averagePath(mode, statistic, period) {
  const params = new URLSearchParams({
    mode,
    dimension: "hours",
    metric: "players",
    period,
    statistic,
  });
  return `/api/average?${params}`;
}

function seasonalAveragePath(cycle, statistic, period) {
  const params = new URLSearchParams({
    cycle,
    dimension: "hours",
    metric: "players",
    period,
    statistic,
  });
  return `/api/seasonal/average?${params}`;
}

function arenaAveragePath(arenaMode, statistic) {
  const params = new URLSearchParams({
    mode: "arena",
    arenaMode,
    dimension: "matches",
    metric: "players",
    statistic,
  });
  return `/api/average?${params}`;
}

async function warmAverageCache() {
  for (const statistic of statistics) {
    for (const mode of modes) {
      for (const period of periods) {
        await request(averagePath(mode, statistic, period));
      }
    }
    for (const arenaMode of arenaModes) {
      await request(arenaAveragePath(arenaMode, statistic));
    }
  }

  const cycle = process.env.SEASONAL_CYCLE_ID?.trim();
  if (process.env.SEASONAL_ENABLED === "true" && cycle) {
    for (const statistic of statistics) {
      for (const period of periods) {
        await request(seasonalAveragePath(cycle, statistic, period));
      }
    }
  }

  await request("/api/progression/average?mode=regular");
  await request("/api/progression/average?mode=pve");
  await request("/api/average/achievements?mode=regular");
  await request("/api/average/achievements?mode=pve");
  if (process.env.SEASONAL_ENABLED === "true" && cycle) {
    await request(`/api/progression/average?mode=seasonal&cycle=${encodeURIComponent(cycle)}`);
    await request(`/api/average/achievements?mode=seasonal&cycle=${encodeURIComponent(cycle)}`);
  }
}

async function waitForWeb() {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await request(averagePath("regular", "trimmed_mean", "all"));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
  }
  throw lastError ?? new Error("web service did not become ready");
}

async function runWarm(reason) {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  try {
    await warmAverageCache();
    console.log(`average cache warm completed (${reason}) in ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.warn(`average cache warm failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }
}

await waitForWeb();
await runWarm("startup");
setInterval(() => void runWarm("interval"), intervalMs);

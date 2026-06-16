const fs = require("fs");
const path = require("path");

const PLAYER_INDEX_URL = "https://players.tarkov.dev/profile/index.json";
const PLAYER_PROFILE_URL = "https://player.tarkov.dev/account/";
const SAMPLE_SIZE = 5000;
const DELAY_MS = 300;
const MAX_RETRIES = 3;

const BUCKETS = [
  { label: "1-50 raids", minRaids: 1, maxRaids: 50 },
  { label: "51-200 raids", minRaids: 51, maxRaids: 200 },
  { label: "201-500 raids", minRaids: 201, maxRaids: 500 },
  { label: "501-1000 raids", minRaids: 501, maxRaids: 1000 },
  { label: "1001-2000 raids", minRaids: 1001, maxRaids: 2000 },
  { label: "2001+ raids", minRaids: 2001, maxRaids: 999999 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCounterValue(items, ...keys) {
  if (!items) return 0;
  const entry = items.find(
    (item) =>
      item.Key.length === keys.length &&
      keys.every((k, i) => item.Key[i] === k)
  );
  return entry?.Value ?? 0;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i === retries - 1) {
        console.error(`Failed after ${retries} retries: ${url}`, err.message);
        return null;
      }
      await sleep(1000 * (i + 1));
    }
  }
  return null;
}

async function main() {
  console.log("Fetching player index...");
  const index = await fetchWithRetry(PLAYER_INDEX_URL);
  if (!index) {
    console.error("Failed to fetch player index");
    process.exit(1);
  }

  const accountIds = Object.keys(index);
  console.log(`Total players in index: ${accountIds.length}`);

  // Shuffle and sample
  for (let i = accountIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [accountIds[i], accountIds[j]] = [accountIds[j], accountIds[i]];
  }
  const sampled = accountIds.slice(0, SAMPLE_SIZE);
  console.log(`Sampling ${sampled.length} players...`);

  const bucketData = BUCKETS.map((b) => ({ ...b, players: [] }));
  let processed = 0;
  let failed = 0;

  for (const aid of sampled) {
    const profile = await fetchWithRetry(`${PLAYER_PROFILE_URL}${aid}`);
    processed++;

    if (!profile) {
      failed++;
      if (processed % 100 === 0)
        console.log(`Progress: ${processed}/${sampled.length} (${failed} failed)`);
      await sleep(DELAY_MS);
      continue;
    }

    const pmc = profile.pmcStats;
    const scav = profile.scavStats;
    const pmcRaids = pmc?.eft?.totalRaidCount ?? 0;
    const scavRaids = scav?.eft?.totalRaidCount ?? 0;
    const totalRaids = pmcRaids + scavRaids;

    if (totalRaids === 0) {
      await sleep(DELAY_MS);
      continue;
    }

    const pmcSurvived = pmc?.eft?.survivedRaidCount ?? 0;
    const scavSurvived = scav?.eft?.survivedRaidCount ?? 0;
    const survivalRate = ((pmcSurvived + scavSurvived) / totalRaids) * 100;

    const pmcCounters = pmc?.overAllCounters?.Items ?? [];
    const scavCounters = scav?.overAllCounters?.Items ?? [];
    const kills =
      getCounterValue(pmcCounters, "Kills") +
      getCounterValue(scavCounters, "Kills");
    const deaths =
      getCounterValue(pmcCounters, "Deaths") +
      getCounterValue(scavCounters, "Deaths");

    const kd = deaths > 0 ? kills / deaths : kills;
    const killsPerRaid = kills / totalRaids;

    const playerData = {
      totalRaids,
      kd: Math.round(kd * 100) / 100,
      survivalRate: Math.round(survivalRate * 10) / 10,
      killsPerRaid: Math.round(killsPerRaid * 100) / 100,
      totalKills: kills,
    };

    const bucket = bucketData.find(
      (b) => totalRaids >= b.minRaids && totalRaids <= b.maxRaids
    );
    if (bucket) bucket.players.push(playerData);

    if (processed % 100 === 0)
      console.log(`Progress: ${processed}/${sampled.length} (${failed} failed)`);

    await sleep(DELAY_MS);
  }

  const result = bucketData.map((b) => ({
    label: b.label,
    minRaids: b.minRaids,
    maxRaids: b.maxRaids,
    sampleSize: b.players.length,
    medianKD: Math.round(median(b.players.map((p) => p.kd)) * 100) / 100,
    medianSurvivalRate:
      Math.round(median(b.players.map((p) => p.survivalRate)) * 10) / 10,
    medianKillsPerRaid:
      Math.round(median(b.players.map((p) => p.killsPerRaid)) * 100) / 100,
    medianTotalKills: Math.round(
      median(b.players.map((p) => p.totalKills))
    ),
    medianRaids: Math.round(median(b.players.map((p) => p.totalRaids))),
  }));

  const outPath = path.join(__dirname, "..", "data", "benchmarks.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nBenchmarks written to ${outPath}`);
  console.log("Bucket summary:");
  result.forEach((b) =>
    console.log(
      `  ${b.label}: ${b.sampleSize} players, median K/D=${b.medianKD}, survival=${b.medianSurvivalRate}%`
    )
  );
}

main().catch(console.error);

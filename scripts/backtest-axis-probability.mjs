import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildAxisWinProbabilities, AXIS_PREDICTION_VERSION } from "../lib/axis-win-probability.ts";
import { AXIS_CHANNEL_ID } from "../lib/axis-league.ts";
import { AXIS_CURRENT_SEASON_START } from "../lib/axis-seasons.ts";

function bins(rows, probability, outcome, count, start = 0, width = .1) {
  return Array.from({ length: count }, (_, index) => {
    const selected = rows.filter(row => Math.min(count - 1, Math.max(0, Math.floor((probability(row) - start + 1e-12) / width))) === index);
    if (!selected.length) return null;
    const n = selected.length;
    const expected = selected.reduce((sum, row) => sum + probability(row), 0) / n;
    const wins = selected.reduce((sum, row) => sum + outcome(row), 0);
    const observed = wins / n;
    const z = 1.96, denominator = 1 + z * z / n;
    const center = (observed + z * z / (2 * n)) / denominator;
    const margin = z * Math.sqrt(observed * (1 - observed) / n + z * z / (4 * n * n)) / denominator;
    return { from: start + index * width, to: Math.min(1, start + (index + 1) * width), n, wins, expected, observed, wilson95: [center - margin, center + margin] };
  }).filter(Boolean);
}

export function summarizeAxisProbabilities(rows) {
  const n = rows.length;
  const favorites = rows.filter(row => row.a !== .5);
  const favoriteOutcome = row => Number((row.a > .5 ? 0 : 1) === row.winner);
  const reliability = bins(rows, row => row.a, row => Number(row.winner === 0), 10);
  const favoriteReliability = bins(favorites, row => Math.max(row.a, 1 - row.a), favoriteOutcome, 5, .5);
  const error = (groups, total) => total ? groups.reduce((sum, bin) => sum + bin.n * Math.abs(bin.expected - bin.observed), 0) / total : null;
  const correct = favorites.reduce((sum, row) => sum + favoriteOutcome(row), 0);
  return {
    n, favoritePredictions: favorites.length, equalOdds: n - favorites.length, correct,
    accuracy: favorites.length ? correct / favorites.length : null,
    brier: n ? rows.reduce((sum, row) => sum + (row.a - Number(row.winner === 0)) ** 2, 0) / n : null,
    logLoss: n ? rows.reduce((sum, row) => sum - Math.log(Math.max(1e-12, row.winner === 0 ? row.a : 1 - row.a)), 0) / n : null,
    ece: error(reliability, n), favoriteEce: error(favoriteReliability, favorites.length),
    reliability, favoriteReliability,
  };
}

export function backtestAxisProbabilities(matches, developmentCount = 2400) {
  if (!Array.isArray(matches) || !Number.isSafeInteger(developmentCount) || developmentCount < 1) throw new TypeError("Invalid Axis backtest input");
  if (matches.some(match => !match || !Number.isSafeInteger(match.number) || match.number < 1)
    || new Set(matches.map(match => match.number)).size !== matches.length) throw new TypeError("Invalid or duplicate Axis match number");
  const predictions = buildAxisWinProbabilities(matches);
  const rows = matches.filter(match => match.queueId === AXIS_CHANNEL_ID && match.time != null && Number.isFinite(match.time)
    && (match.winner === 0 || match.winner === 1) && predictions.has(match.number))
    .sort((a, b) => a.time - b.time || a.number - b.number)
    .map(match => ({ number: match.number, time: match.time, winner: match.winner, ...predictions.get(match.number) }));
  const cutoff = rows[Math.min(developmentCount, rows.length) - 1]?.time;
  // A simultaneous timestamp must not be split between development and validation.
  const development = rows.filter(row => row.time <= cutoff), validation = rows.filter(row => row.time > cutoff);
  return {
    modelVersion: AXIS_PREDICTION_VERSION, archiveEntries: matches.length,
    split: { requestedDevelopmentCount: developmentCount, developmentLastMatch: development.at(-1)?.number ?? null,
      validationFirstMatch: validation[0]?.number ?? null, cutoff: cutoff ?? null },
    development: summarizeAxisProbabilities(development), validation: summarizeAxisProbabilities(validation),
    currentSeason: summarizeAxisProbabilities(rows.filter(row => row.time >= AXIS_CURRENT_SEASON_START)),
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { "development-count": { type: "string", default: "2400" } } });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(values["development-count"])) throw new TypeError("Usage: node --experimental-strip-types scripts/backtest-axis-probability.mjs archive.json [--development-count 2400]");
    const matches = JSON.parse(await readFile(positionals[0], "utf8"));
    process.stdout.write(JSON.stringify(backtestAxisProbabilities(matches, Number(values["development-count"])), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

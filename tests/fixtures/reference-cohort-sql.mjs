// Frozen pre-optimization SQL: independent exact-output regression reference.
const COMPARISON_RADAR_METRICS = ['kd_ratio','pmc_kd_ratio','kills_per_raid','killed_pmc_per_raid','pmc_survival_rate','longest_win_streak','level'];
const MIN_N_FOR_TRIM = 20;
const TRIM_FRACTION = 0.05;
const PVP_METRICS = new Set(['pmc_kd_ratio','killed_pmc']);

// The shared-summary implementation shipped immediately before the LIMIT/OFFSET
// optimization. Keep this benchmark baseline independent from production SQL.
export function referenceSharedComparisonMetricsSql(mode, where, statistic) {
  const selected = statistic === "median"
    ? "rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))"
    : `rn > CASE WHEN n >= 20 THEN CAST(n * 0.05 AS INTEGER) ELSE 0 END
       AND rn <= n - CASE WHEN n >= 20 THEN CAST(n * 0.05 AS INTEGER) ELSE 0 END`;
  const metricWhere = (metric) => `${metric} IS NOT NULL${metric === "pmc_survival_rate" ? " AND pmc_survival_rate > 0" : ""}${mode === "pve" && PVP_METRICS.has(metric) ? " AND pvp_stats_known = 1" : ""}`;
  const perMetric = COMPARISON_RADAR_METRICS.map((metric, index) =>
    `SELECT '${metric}' AS metric, MAX(n) AS n,
      AVG(CASE WHEN ${selected} THEN v END) AS a,
      SUM(CASE WHEN v < player_v THEN 1 ELSE 0 END) AS below,
      SUM(CASE WHEN v = player_v THEN 1 ELSE 0 END) AS equal, NULL, NULL, NULL, NULL
      FROM (SELECT ${metric} AS v, ? AS player_v, ROW_NUMBER() OVER (ORDER BY ${metric}) AS rn,
        count_${index} AS n FROM cohort CROSS JOIN summary WHERE ${metricWhere(metric)})`
  ).join("\n UNION ALL\n");
  const table = mode === "pve" ? "mode_players" : "players";
  const index = mode === "pve" ? "idx_mode_players_cohort" : "idx_players_cohort";
  return `WITH cohort AS MATERIALIZED (
    SELECT hours, pmc_raids, pvp_stats_known, ${COMPARISON_RADAR_METRICS.filter((metric) => metric !== "killed_pmc_per_raid").join(", ")},
      CASE WHEN pvp_stats_known = 1 AND pvp_stats_version = 1 AND pmc_raids > 0
        THEN 1.0 * pmc_killed_pmc / pmc_raids END AS killed_pmc_per_raid
    FROM ${table} INDEXED BY ${index} ${where.replace(/\bplayers\./g, `${table}.`)}${mode === "pve" ? " AND mode = 'pve'" : ""}
  ), summary AS MATERIALIZED (
    SELECT COUNT(*) AS n, MIN(hours) AS hours_min, MAX(hours) AS hours_max,
      MIN(pmc_raids) AS raids_min, MAX(pmc_raids) AS raids_max,
      ${COMPARISON_RADAR_METRICS.map((metric, index) => `COUNT(CASE WHEN ${metricWhere(metric)} THEN 1 END) AS count_${index}`).join(", ")}
    FROM cohort
  ) SELECT '__group__' AS metric, n, NULL AS a, NULL AS below, NULL AS equal,
    hours_min, hours_max, raids_min, raids_max FROM summary
  UNION ALL ${perMetric}`;
}
export function referenceComparisonMetricsSql(
  mode,
  where,
  statistic,
) {
  const selected = statistic === "median"
    ? "rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))"
    : `rn > CASE WHEN n >= ${MIN_N_FOR_TRIM} THEN CAST(n * ${TRIM_FRACTION} AS INTEGER) ELSE 0 END
       AND rn <= n - CASE WHEN n >= ${MIN_N_FOR_TRIM} THEN CAST(n * ${TRIM_FRACTION} AS INTEGER) ELSE 0 END`;
  // One ranked pass per metric over the shared cohort CTE. Ranking the six
  // metrics together meant a UNION ALL that expanded the cohort six times first,
  // so the statement wrote and then sorted six figures worth of rows. That is
  // cheap for a matched window of a few hundred rows and ruinous for the
  // population fallback, which has no window and aggregates every eligible row.
  // Ranking each metric on its own keeps the cohort at one row per player.
  const perMetric = COMPARISON_RADAR_METRICS.map((metric) =>
    `SELECT '${metric}' AS metric, MAX(n) AS n,
      AVG(CASE WHEN ${selected} THEN v END) AS a,
      SUM(CASE WHEN v < player_v THEN 1 ELSE 0 END) AS below,
      SUM(CASE WHEN v = player_v THEN 1 ELSE 0 END) AS equal, NULL, NULL, NULL, NULL
      FROM (SELECT ${metric} AS v, ? AS player_v, ROW_NUMBER() OVER (ORDER BY ${metric}) AS rn,
        COUNT(*) OVER () AS n FROM cohort WHERE ${metric} IS NOT NULL${
      metric === "pmc_survival_rate" ? " AND pmc_survival_rate > 0" : ""
    }${mode === "pve" && PVP_METRICS.has(metric) ? " AND pvp_stats_known = 1" : ""})`
  ).join("\n    UNION ALL\n    ");
  // Materialize once: SQLite otherwise inlines the CTE into each metric and
  // can select a narrow PvP index that reads every large profile row again.
  const index = mode === "pve" ? "idx_mode_players_cohort" : "idx_players_cohort";
  // INDEXED BY must name a table, not the pve_players view used by other reads.
  const table = mode === "pve" ? "mode_players" : "players";
  return `WITH cohort AS MATERIALIZED (
    SELECT hours, pmc_raids, pvp_stats_known, ${COMPARISON_RADAR_METRICS.filter((metric) => metric !== "killed_pmc_per_raid").join(", ")},
      CASE WHEN pvp_stats_known = 1 AND pvp_stats_version = 1 AND pmc_raids > 0
        THEN 1.0 * pmc_killed_pmc / pmc_raids END AS killed_pmc_per_raid FROM ${table} INDEXED BY ${index} ${where.replace(/\bplayers\./g, `${table}.`)}${mode === "pve" ? " AND mode = 'pve'" : ""}
  )
  SELECT '__group__' AS metric, COUNT(*) AS n, NULL AS a,
    NULL AS below, NULL AS equal,
    MIN(hours) AS hours_min, MAX(hours) AS hours_max,
    MIN(pmc_raids) AS raids_min, MAX(pmc_raids) AS raids_max
  FROM cohort
  UNION ALL
  ${perMetric}`;
}



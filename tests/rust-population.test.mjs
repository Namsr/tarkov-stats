import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { createPopulationFixture, syntheticPopulationRows, assertPopulationParity, POPULATION_COLUMNS } from "./fixtures/rust-population-data.mjs";
import { rustCohortBinary, DAY_MS } from "./fixtures/rust-cohort-data.mjs";
const { CohortComputeWorker } = await import("../lib/cohort-worker.ts");
const { computeAverage } = await import("../lib/average-compute.ts");
const { computeAverageMetricSeries } = await import("../lib/average-metric-series.ts");
const METRICS = ["players", "kd_ratio", "pmc_kd_ratio", "survival_rate", "kills_per_raid", "total_raids", "pmc_raids", "total_kills", "killed_pmc", "deaths", "prestige", "level", "longest_win_streak", "achv_count"];
const args = (extra = {}) => { const q = { dimension: "hours", metric: "players", bins: 36, statistic: "trimmed_mean", period: "all", min: null, max: null, inclusive: true, ...extra }; return [q.dimension,q.metric,q.bins,q.statistic,q.period,q.min,q.max,q.inclusive]; };

test("native persistent population and metric batches match actual TS SQLite calculations", { timeout: 180000 }, async (t) => {
  const fixture = await createPopulationFixture(); const binary = rustCohortBinary(); assert.ok(existsSync(binary), "build the native worker before this suite");
  const worker = new CohortComputeWorker({ executable: binary });
  t.after(async () => { worker.stop(); await fixture.close(); });
  async function average(mode = "pve", extra = {}) { const query = args(extra); const expected = JSON.parse(JSON.stringify(await computeAverage(mode, ...query))); const actual = await worker.compute({ kind: "persistent_average", mode, args: query }); assertPopulationParity(actual, expected, JSON.stringify([mode,...query])); return actual.body; }
  async function metrics(mode = "pve", statistic = "median", period = "all") { const expected = await computeAverageMetricSeries({ mode, cycleId: "persistent", statistic, period }); const actual = await worker.compute({ kind: "persistent_metrics", mode, args: [statistic,period] }); assertPopulationParity(actual, expected, `metrics ${mode}/${statistic}/${period}`); return actual; }
  await t.test("initialized empty storage preserves every null/count/fallback field", async () => { fixture.clear(); for (const mode of ["regular","pve"]) { const body = await average(mode); assert.equal(body.averages.n,0); assert.equal(body.averages.kd_ratio,null); assert.equal(body.metricCounts.kd_ratio,0); assert.equal(body.total,0); assert.deepEqual(body.histogram,[]); await average(mode,{ dimension:"pmc_raids",statistic:"median" }); await metrics(mode); } });
  await t.test("all metrics/statistics/dimensions/periods preserve mode identity and tombstones", async () => {
    fixture.clear(); const now=Date.now(); for(const mode of ["regular","pve","arena"])fixture.seed(syntheticPopulationRows(121,{mode,now}),mode,now);
    fixture.db.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES(7,'private fixture',1)");
    for(const mode of ["regular","pve"])for(const statistic of ["median","trimmed_mean"])for(const period of ["all","90d"]) {
      for(const dimension of ["hours","pmc_raids"])for(const metric of METRICS)await average(mode,{statistic,period,dimension,metric,bins:8});
      await metrics(mode,statistic,period);
    }
    const body=await average("pve"); assert.equal(body.total,120); assert.equal(body.averages.n,120); assert.ok(body.metricCounts.killed_pmc<120);
    assert.equal((await average("pve",{metric:"not-a-metric"})).metric,"players");
  });
  await t.test("range endpoints are inclusive/exclusive only for portraits; distributions and population stay unfiltered", async () => {
    fixture.clear();for(const mode of ["regular","pve"])fixture.seed([0,49.9,50,99.9,100,1999.9,2000,2099.9,10000,20000].map((hours,i)=>({aid:i+1,hours,pmc_raids:hours,total_raids:i+1,kd_ratio:i/3})),mode);
    for(const mode of ["regular","pve"])for(const dimension of ["hours","pmc_raids"])for(const statistic of ["median","trimmed_mean"])for(const range of [{min:50,max:100},{min:50,max:100,inclusive:false},{min:100,max:100},{min:999999},{max:0}])await average(mode,{...range,dimension,statistic,metric:"kd_ratio"});
    const body=await average("pve",{min:50,max:100});assert.equal(body.averages.n,3);assert.equal(body.total,10);assert.equal(body.buckets.reduce((n,b)=>n+b.n,0),10);
  });
  await t.test("19/20/21 portrait trim boundaries, ties, missing and zero metrics remain independent", async () => {
    for(const count of [1,2,19,20,21,40]){fixture.clear();for(const mode of ["regular","pve"])fixture.seed(Array.from({length:count},(_,i)=>({aid:i+1,hours:100,pmc_raids:100,kd_ratio:i===count-1?10000:i%4,pmc_kd_ratio:i%3===0?null:0,killed_pmc:i%5===0?null:i,pvp_stats_known:i%2,pmc_survival_rate:0,survival_rate:0})),mode);for(const mode of ["regular","pve"])for(const statistic of ["median","trimmed_mean"]){const body=await average(mode,{statistic,metric:"kd_ratio"});assert.equal(body.metricCounts.survival_rate,count);assert.equal(body.averages.survival_rate,0);assert.equal(body.averages.pmc_survival_rate,0);await metrics(mode,statistic);}}
  });
  await t.test("fixed bucket transitions, null coordinates, negative legacy metrics and adaptive pooling match", async () => {
    fixture.clear(); const points=[null,-100,-0.5,0,24.9,25,49.9,50,999.9,1000,1999.9,2000,2999.9,3000,9999.9,10000,20000];
    for(const mode of ["regular","pve"])fixture.seed(Array.from({length:85},(_,i)=>({aid:i+1,hours:points[i%points.length],pmc_raids:points[(i*3)%points.length],kd_ratio:i%9===0?null:(i%7-3)/10,profile_updated_at:i%6===0?null:Date.now(),pvp_stats_known:i%2})),mode);
    for(const mode of ["regular","pve"])for(const dimension of ["hours","pmc_raids"])for(const statistic of ["median","trimmed_mean"])for(const metric of ["players","kd_ratio"])for(const bins of [0,1,2,3.9,36,100])await average(mode,{dimension,statistic,metric,bins});
  });
  await t.test("integer-valued median bucket SQL and current SQLite Number coercions stay exact", async () => {
    fixture.clear(); for(const mode of ["regular","pve"])fixture.seed([{aid:1,hours:100,pmc_raids:100,total_raids:1},{aid:2,hours:100,pmc_raids:100,total_raids:2}],mode);
    for(const mode of ["regular","pve"]){const body=await average(mode,{metric:"total_raids",statistic:"median"});assert.equal(body.averages.total_raids,1.5);assert.equal(body.buckets[0].sum,2);await metrics(mode,"median");}
    fixture.clear(); fixture.seed([{aid:1,hours:"not a number",pmc_raids:100,kd_ratio:"not numeric"},{aid:2,hours:"",pmc_raids:100,kd_ratio:Buffer.from("2")}]);
    // Compare JSONL/HTTP output: JSON.stringify maps JS NaN/Infinity to null.
    await average("pve",{metric:"kd_ratio",statistic:"trimmed_mean"}); await average("pve",{metric:"kd_ratio",statistic:"median"});
    fixture.db.exec("DELETE FROM mode_players WHERE aid=2"); await average("pve",{metric:"kd_ratio",statistic:"median"});
  });
  await t.test("recency uses profile_updated_at not last_played_at and metadata version is not metric eligibility", async () => {
    fixture.clear(); const now=Date.now();for(const mode of ["regular","pve"])fixture.seed([{aid:1,hours:100,pmc_raids:100,pvp_stats_known:1,pvp_stats_version:0,pmc_kd_ratio:2,killed_pmc:3,profile_updated_at:now-DAY_MS},{aid:2,hours:200,pmc_raids:200,pvp_stats_known:0,pmc_kd_ratio:100,killed_pmc:100,profile_updated_at:now-DAY_MS},{aid:3,hours:300,pmc_raids:300,profile_updated_at:now-100*DAY_MS,last_played_at:now},{aid:4,hours:400,pmc_raids:400,profile_updated_at:null,last_played_at:now}],mode,now);
    for(const mode of ["regular","pve"]){const body=await average(mode,{period:"90d"});assert.equal(body.total,2);assert.equal(body.metricCounts.killed_pmc,1);assert.equal(body.averages.killed_pmc,3);assert.equal(body.metricCounts.pmc_kd_ratio,1);await average(mode,{period:"all"});await metrics(mode,"median","90d");}
  });
  await t.test("failed malformed jobs do not poison the reused process or the other job kind", async () => {
    for(const job of [{kind:"persistent_average",mode:"arena",args:args()},{kind:"persistent_average",mode:"pve",args:args({dimension:"bad"})},{kind:"persistent_average",mode:"pve",args:args({min:-1})},{kind:"persistent_average",mode:"pve",args:args({min:5,max:1})},{kind:"persistent_average",mode:"pve",args:args().slice(0,-1)},{kind:"persistent_metrics",mode:"pve",args:["bad","all"]},{kind:"persistent_metrics",mode:"pve",args:["median","all","extra"]}])await assert.rejects(worker.compute(job));
    await average(); await metrics();
  });
  await t.test("a missing readonly storage path never creates a SQLite file", async () => {
    const old=process.env.SQLITE_PATH;const path=join(fixture.directory,"missing-readonly.db");process.env.SQLITE_PATH=path;const missing=new CohortComputeWorker({executable:binary});try{const result=await missing.compute({kind:"persistent_average",mode:"pve",args:args()});assert.equal(result.storage,"unavailable");assert.equal(result.body.averages,null);assert.equal(await missing.compute({kind:"persistent_metrics",mode:"pve",args:["median","all"]}),null);assert.equal(existsSync(path),false);
      writeFileSync(path, "");
      assert.equal((await missing.compute({kind:"persistent_average",mode:"pve",args:args()})).storage,"unavailable");
      const repaired=new DatabaseSync(path);
      try { const schema=fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN('players','mode_players','excluded_players')").all().map(row=>row.sql).join(";"); repaired.exec(schema); } finally { repaired.close(); }
      const healthy=await missing.compute({kind:"persistent_average",mode:"pve",args:args()});assert.equal(healthy.storage,"sqlite");assert.equal(healthy.body.total,0);assert.equal(healthy.body.averages.n,0);
      assert.equal((await missing.compute({kind:"persistent_metrics",mode:"pve",args:["median","all"]})).mode,"pve");
    }finally{missing.stop();process.env.SQLITE_PATH=old;}
  });
  await t.test("SQL errors after readiness reject rather than returning unavailable; subsequent work still succeeds", async () => {
    fixture.db.exec("ALTER TABLE players RENAME COLUMN kd_ratio TO temporarily_missing_metric");try{await assert.rejects(worker.compute({kind:"persistent_average",mode:"regular",args:args()}));}finally{fixture.db.exec("ALTER TABLE players RENAME COLUMN temporarily_missing_metric TO kd_ratio");}await average("regular");await metrics("regular");
  });
  assert.equal(POPULATION_COLUMNS.length,17);
});

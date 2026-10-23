import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// node --max-old-space-size=128 --experimental-strip-types scripts/benchmark-progression-materialization.mjs SOURCE_ROOT REPORT.json
// Run baseline/candidate sequentially with identical Node, temp directory and
// BENCH_PLAYERS/SNAPSHOTS/PADDING. This creates synthetic data, never production.
// Initial means first materialization, not an OS-cold filesystem cache.
const root = resolve(process.argv[2] || '.');
const players = Number(process.env.BENCH_PLAYERS || 2000);
const snapshotsPerPlayer = Number(process.env.BENCH_SNAPSHOTS || 24);
const padding = Number(process.env.BENCH_PADDING || 2048);
const load = (file) => import(pathToFileURL(join(root, file)).href);
const { initializeSeasonalSchema } = await load('lib/seasonal/storage.ts');
const { materializeDuePopulations } = await load('scripts/materialize-progression-population.mjs');
const directory = mkdtempSync(join(process.env.BENCH_TMPDIR || tmpdir(), 'progression-benchmark-'));
const file = join(directory, 'progression.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250');
initializeSeasonalSchema(db);
const day = 86_400_000, start = 1780000000000;
const snapshot = db.prepare(`INSERT INTO progression_snapshots
  (mode,cycle_id,aid,profile_updated_at,upstream_updated_at,captured_at,local_date,stats_json,
   achievements,level,hours)
  VALUES ('regular','persistent',?,?,?,?,'2026-05-29',?,'["a","b"]',?,?)`);
function insert(aid, version) {
  const raids = version * (aid % 11 + 1), time = start + version * day;
  const hours = [25,75,150,350,750,1500,3500,7000][aid % 8];
  const stats = { experience: raids * (100 + aid % 101), pmcRaids: raids, scavRaids: version,
    pmcSurvived: Math.floor(raids * .6), pmcDeaths: Math.floor(raids * .4),
    pmcKills: raids * 3, killedPmc: raids, pmcKilledPmc: raids, pvpStatsKnown: true,
    nickname: `p${aid}`, hoursPlayed: hours, padding: 'x'.repeat(padding) };
  snapshot.run(aid, time, time, time + 1, JSON.stringify(stats), 1 + aid % 60, hours);
}
db.exec('BEGIN');
for (let aid=1; aid<=players; aid++) for (let v=1; v<=snapshotsPerPlayer; v++) insert(aid,v);
db.exec('COMMIT');
const scopes = [{ mode:'regular', cycleId:'persistent' }];
const report = { node:process.version, platform:process.platform,
  sqlite:db.prepare('SELECT sqlite_version() version').get().version,
  pragmas:Object.fromEntries(['journal_mode','synchronous','cache_size','temp_store','page_size'].map(name=>[name,db.prepare('PRAGMA '+name).get()])),
  players, snapshotsPerPlayer, padding, databaseBytes:statSync(file).size, phases:[] };
let active, mainCommitStarted;
const audited = {
  prepare(sql) {
    const statement = db.prepare(sql);
    const count = () => { if(active) active.statements[sql] = (active.statements[sql] || 0) + 1; };
    const countMutation = () => {
      if(active && /^(?:INSERT INTO|UPDATE|DELETE FROM) (?:progression_intervals|daily_aggregates|progression_population_generations|progression_population_current|progression_materializations)\b/.test(sql.trim())) {
        active.persistedRowChanges+=Number(db.prepare('SELECT changes() n').get().n);
      }
    };
    return {
      run(...args) { count(); const result=statement.run(...args); countMutation(); return result; },
      get(...args) { count(); const result=statement.get(...args); countMutation(); return result; },
      all(...args) { count(); return statement.all(...args); },
      iterate(...args) { count(); return statement.iterate(...args); },
    };
  },
  exec(sql) {
    if(active && sql.startsWith("DROP TABLE IF EXISTS temp.")) {
      const table=sql.slice('DROP TABLE IF EXISTS temp.'.length);
      if(table.startsWith('progression_population_') && db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name=?").get(table)) {
        active.tempQueryPlans ||= [];
        const query='SELECT * FROM '+table+' ORDER BY rowid';
        active.tempQueryPlans.push({sql:query,plan:db.prepare('EXPLAIN QUERY PLAN '+query).all()});
      }
      active.tempAllocatedBytes=Math.max(active.tempAllocatedBytes||0, Number(db.prepare('PRAGMA temp.page_count').get().page_count)*Number(db.prepare('PRAGMA temp.page_size').get().page_size));
    }
    if (/SAVEPOINT (refresh_progression_aggregates|publish_progression_population)$/.test(sql)) mainCommitStarted=performance.now();
    const before = active && /^INSERT INTO daily_aggregates/.test(sql) ? Number(db.prepare('SELECT total_changes() n').get().n) : null;
    db.exec(sql);
    if(before!==null) active.persistedRowChanges+=Number(db.prepare('SELECT total_changes() n').get().n)-before;
    if (/RELEASE (refresh_progression_aggregates|publish_progression_population)$/.test(sql)) {
      active.commitSectionsMs.push(performance.now()-mainCommitStarted);
    }
  },
};
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  for (const [index,name] of ['initial','unchanged','one_percent'].entries()) {
    if(index===2) {
      db.exec('BEGIN');
      for(let aid=1;aid<=Math.max(1,Math.floor(players/100));aid++) insert(aid,snapshotsPerPlayer+1);
      db.exec('COMMIT');
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = Number(db.prepare('SELECT total_changes() n').get().n);
    active = { name, statements:{}, commitSectionsMs:[], persistedRowChanges:0 };
    const started=performance.now();
    const result=await materializeDuePopulations(audited, scopes, {now:start+60*day+index*21_600_001});
    if(result.errors.length) throw new Error(JSON.stringify(result.errors));
    active.durationMs=performance.now()-started;
    process.stderr.write(`${name}: ${Math.round(active.durationMs)}ms\n`);
    active.workerPhases=result.phases;
    active.changes=Number(db.prepare('SELECT total_changes() n').get().n)-before;
    active.walBytes=statSync(file+'-wal').size;
    active.peakRssMiB=process.resourceUsage().maxRSS/1024;
    const payload=JSON.parse(db.prepare(`SELECT g.payload FROM progression_population_current c
      JOIN progression_population_generations g USING(mode,cycle_id,generation)`).get().payload);
    // The scheduled time changes; formulas and every other output must match.
    delete payload.average.generatedAt;
    active.payloadHash=hash(JSON.stringify(payload));
    const intervalHash=createHash('sha256');
    for(const row of db.prepare('SELECT * FROM progression_intervals ORDER BY id').iterate()) intervalHash.update(JSON.stringify(row));
    active.intervalsHash=intervalHash.digest('hex');
    active.aggregatesHash=hash(JSON.stringify(db.prepare('SELECT * FROM daily_aggregates ORDER BY mode,cycle_id,local_date,kind,dimension,bucket_min').all()));
    active.queryPlans=active.tempQueryPlans||[];
    delete active.tempQueryPlans;
    for(const [originalSql,calls] of Object.entries(active.statements)) {
      const sql=originalSql.replace(/^CREATE TEMP TABLE \w+ AS\s+/, '');
      if(!/^SELECT|^WITH/.test(sql) || !/FROM progression_|FROM player_profiles/.test(sql) || /sqlite_master|table_info|progression_normalizations/.test(sql)) continue;
      try {active.queryPlans.push({sql,calls,plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(...Array((sql.match(/\?/g)||[]).length).fill(null))});} catch { /* Temporary sources have been dropped. */ }
    }
    active.statementExecutions=Object.values(active.statements).reduce((sum,n)=>sum+n,0);
    active.statements=Object.entries(active.statements).filter(([sql])=>/CREATE TEMP|SELECT \* FROM progression_|SELECT s\.aid|SELECT p\.lifetime|WITH ranked|DELETE FROM daily|INSERT INTO daily/.test(sql));
    report.phases.push(active);
    active=null;
  }
  const output=JSON.stringify(report,null,2);
  if(process.argv[3]) writeFileSync(process.argv[3],output+'\n');
  console.log(JSON.stringify(report.phases.map(({name,durationMs,walBytes,changes,peakRssMiB,workerPhases,payloadHash,intervalsHash,aggregatesHash,statementExecutions,commitSectionsMs,persistedRowChanges,tempAllocatedBytes})=>({name,durationMs,walBytes,changes,peakRssMiB,workerPhases,payloadHash,intervalsHash,aggregatesHash,statementExecutions,commitSectionsMs,persistedRowChanges,tempAllocatedBytes})),null,2));
} finally {db.close();rmSync(directory,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSeasonalSchema } from '../lib/seasonal/storage.ts';
import { refreshSqliteProgressionAggregates } from '../lib/seasonal/daily-aggregates.ts';
import { materializeSqlitePopulationSnapshot } from '../lib/seasonal/progression-db.ts';
import { buildProgressionMetricSeries } from '../lib/seasonal/progression.ts';
import { retrySqliteBusy } from '../lib/sqlite-busy-retry.ts';

function seed(db, mode='regular', cycle='persistent') {
  initializeSeasonalSchema(db);
  const profile=db.prepare(`INSERT INTO player_profiles
    (mode,cycle_id,aid,nickname,profile_updated_at,last_access_at,lifetime_pvp_hours,
    experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,first_seen_at,last_seen_at)
    VALUES (?,?,?,'fixture',3,3,100,3000,3,0,2,1,9,3,1,3)`);
  const snapshot=db.prepare(`INSERT INTO progression_snapshots
    (mode,cycle_id,aid,profile_updated_at,upstream_updated_at,captured_at,local_date,experience,
     pmc_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,stats_json,level)
    VALUES (?,?,?,?,?,?,'2026-10-22',?,?,?,?,?,?,?,1)`);
  const interval=db.prepare(`INSERT INTO progression_intervals
    (mode,cycle_id,aid,from_snapshot_id,to_snapshot_id,ended_at,local_date,elapsed_days,status,
     experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,confidence)
    VALUES (?,?,?,?,?,?,'2026-10-22',1,'valid',?,1,0,1,1,3,1,1)`);
  db.exec('BEGIN');
  for(let aid=1;aid<=240;aid++) {
    profile.run(mode,cycle,aid);
    let previous;
    for(let v=1;v<=3;v++) {
      const id=Number(snapshot.run(mode,cycle,aid,v,v,v,aid*v, v,v,v,v*3,v,
        JSON.stringify({pmcKilledPmc:v, pvpStatsKnown:true})).lastInsertRowid);
      if(previous) interval.run(mode,cycle,aid,previous,id,v,aid);
      previous=id;
    }
  }
  db.exec('COMMIT');
}
const payload=(db,mode='regular',cycle='persistent')=>JSON.parse(db.prepare(`SELECT g.payload
  FROM progression_population_current c JOIN progression_population_generations g USING(mode,cycle_id,generation)
  WHERE c.mode=? AND c.cycle_id=?`).get(mode,cycle).payload);
const scores=db=>db.prepare('SELECT aid,tempo_score,form_score,score_sample_n,score_version FROM progression_intervals ORDER BY id').all();
function wrap(db, hooks={}) {
  return {exec(sql) {hooks.exec?.(sql);db.exec(sql);},prepare(sql) {
    const statement=db.prepare(sql);
    return Object.fromEntries(['all','get','run','iterate'].map(method=>[method,(...args)=> {
      const result=statement[method](...args);
      hooks.after?.(sql,method,result);
      return result;
    }]));
  }};
}
function assertNoStage(db) {
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'progression_%'").all(),[]);
}

test('unchanged aggregate refresh preserves rows; a changed player rescores peers in the whole bucket',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    seed(db);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    const before=scores(db);
    db.exec(`CREATE TABLE changes (operation TEXT);
      CREATE TRIGGER aggregate_insert AFTER INSERT ON daily_aggregates BEGIN INSERT INTO changes VALUES ('insert'); END;
      CREATE TRIGGER aggregate_update AFTER UPDATE ON daily_aggregates BEGIN INSERT INTO changes VALUES ('update'); END;
      CREATE TRIGGER aggregate_delete AFTER DELETE ON daily_aggregates BEGIN INSERT INTO changes VALUES ('delete'); END;`);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    assert.deepEqual(db.prepare('SELECT * FROM changes').all(),[]);
    db.exec('UPDATE progression_intervals SET experience=1000000 WHERE aid=1');
    refreshSqliteProgressionAggregates(db,'regular','persistent',10);
    assert.notDeepEqual(scores(db).filter(row=>row.aid===2),before.filter(row=>row.aid===2), 'a peer must be rescored');
    db.exec('UPDATE progression_snapshots SET experience=experience+1');
    refreshSqliteProgressionAggregates(db,'regular','persistent',10);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM changes').get().n>0);
    const targeted=scores(db);
    const aggregates=db.prepare('SELECT * FROM daily_aggregates ORDER BY kind,bucket_min').all();
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    assert.deepEqual(scores(db),targeted);
    assert.deepEqual(db.prepare('SELECT * FROM daily_aggregates ORDER BY kind,bucket_min').all(),aggregates);
    db.exec('UPDATE player_profiles SET confirmed_banned=1');
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_aggregates').get().n,0);
    assertNoStage(db);
  } finally {db.close();}
});

test('staged rate metrics equal the existing series formulas and read each sorted source once',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    seed(db);
    const counts={snapshot:0,interval:0};
    materializeSqlitePopulationSnapshot(wrap(db,{after(sql,method) {
      if(method==='run' && sql.startsWith('CREATE TEMP TABLE progression_population_snapshot_source')) counts.snapshot++;
      if(method==='iterate' && sql.startsWith('SELECT i.aid, i.id AS point_id')) counts.interval++;
    }}),'regular','persistent',100);
    assert.deepEqual(counts,{snapshot:1,interval:1});
    const actual=payload(db);
    const metricValues={xp_per_day:aid=>aid,pmc_raids_per_day:()=>1,pmc_kills_per_day:()=>1,
      non_pmc_kills_per_day:()=>2,pmc_kills_per_raid:()=>1,non_pmc_kills_per_raid:()=>2};
    for(const [metric,value] of Object.entries(metricValues)) {
      const rows=[];
      for(let aid=1;aid<=240;aid++) for(let v=2;v<=3;v++) rows.push({aid,point_id:(aid-1)*2+v-1,
        local_date:'2026-10-22',observed_at:v,freshness_at:v,value:value(aid),pmc_raids:v,raid_bucket:10,
        lifetime_hours:100,confidence:1,series_id:1,level:1,period_start_at:v-1,elapsed_days:1,
        delta_experience:aid,delta_pmc_raids:1,score_sample_n:null});
      assert.deepEqual(actual.metrics[metric].overall,buildProgressionMetricSeries(rows,{mode:'regular',cycleId:'persistent',aid:-1},metric).overall,metric);
    }
    assertNoStage(db);
  } finally {db.close();}
});

for(const phase of ['aggregate','population']) test(`${phase}: commits on every build do not starve publication or overwrite later intervals`,async()=> {
  const directory=mkdtempSync(join(tmpdir(),'progression-concurrency-'));
  const file=join(directory,'progression.db');
  const db=new DatabaseSync(file);
  let writer;
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1');
    seed(db);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    const before=payload(db);
    writer=new DatabaseSync(file);writer.exec('PRAGMA busy_timeout=1');
    let commits=0,newId;
    const audited=wrap(db,{after(sql,method) {
      const trigger=phase==='aggregate' ? sql.startsWith('CREATE TEMP TABLE progression_interval_source')
        : sql.startsWith('CREATE TEMP TABLE progression_population_snapshot_source');
      if(method!=='run' || !trigger) return;
      commits++;
      assert.deepEqual(payload(writer),before);
      // This does not affect formulas, and must not invalidate a whole build.
      writer.exec('UPDATE player_profiles SET last_access_at=last_access_at+1');
      if(phase==='aggregate') {
        writer.exec('UPDATE progression_intervals SET experience=1000000,tempo_score=999,form_score=999 WHERE aid=1');
        const row=writer.prepare(`INSERT INTO progression_intervals
          (mode,cycle_id,aid,from_snapshot_id,to_snapshot_id,ended_at,local_date,elapsed_days,status,
           experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,confidence,tempo_score,form_score)
          SELECT mode,cycle_id,aid,from_snapshot_id,to_snapshot_id+100000,ended_at,local_date,elapsed_days,status,
            experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,confidence,123,123
          FROM progression_intervals WHERE aid=1 LIMIT 1 RETURNING id`).get();
        newId=row.id;
      }
    }});
    const calculate=handle=>phase==='aggregate' ? refreshSqliteProgressionAggregates(handle,'regular','persistent')
      : materializeSqlitePopulationSnapshot(handle,'regular','persistent',101);
    await retrySqliteBusy(()=>calculate(audited),500);
    assert.equal(commits,1,'a commit on every attempt must still finish the first build');
    if(phase==='aggregate') {
      assert.equal(db.prepare('SELECT tempo_score FROM progression_intervals WHERE id=?').get(newId).tempo_score,123);
      assert.ok(db.prepare('SELECT tempo_score FROM progression_intervals WHERE aid=1 AND id!=?').all(newId).every(row=>row.tempo_score===999));
    } else {
      assert.equal(db.prepare('SELECT generation FROM progression_population_current').get().generation,101);
      assert.deepEqual(payload(db),before,'irrelevant writes do not change formulas');
    }
    assertNoStage(db);
  } finally {writer?.close();db.close();rmSync(directory,{recursive:true,force:true});}
});

for(const phase of ['aggregate','population']) test(`${phase}: interrupted staging and failed commit preserve the previous generation`,()=> {
  const db=new DatabaseSync(':memory:');
  try {
    seed(db);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    const before=payload(db),beforeScores=scores(db);
    const calculate=handle=>phase==='aggregate' ? refreshSqliteProgressionAggregates(handle,'regular','persistent')
      : materializeSqlitePopulationSnapshot(handle,'regular','persistent',101);
    for(const point of ['staging','commit']) {
      const audited=wrap(db,{after(sql,method) {
        if(method==='run' && point==='staging' && sql.startsWith('CREATE TEMP TABLE progression_')) throw new Error('interrupted');
      },exec(sql) {
        if(point==='commit' && sql===`RELEASE ${phase==='aggregate'?'refresh_progression_aggregates':'publish_progression_population'}`) throw new Error('interrupted');
      }});
      assert.throws(()=>calculate(audited),/interrupted/);
      assert.deepEqual(payload(db),before);
      assert.deepEqual(scores(db),beforeScores);
      assertNoStage(db);
    }
    calculate(db);
    assertNoStage(db);
  } finally {db.close();}
});

test('bans, restoration, cycle changes and model upgrades recompute current data without reusing temporary rows',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    seed(db);seed(db,'pve');seed(db,'seasonal','s1');seed(db,'seasonal','s2');
    const publish=(mode,cycle,now)=>{refreshSqliteProgressionAggregates(db,mode,cycle);materializeSqlitePopulationSnapshot(db,mode,cycle,now);return payload(db,mode,cycle);};
    const original=publish('regular','persistent',100);
    const pve=publish('pve','persistent',100);
    db.exec('UPDATE player_profiles SET confirmed_banned=1 WHERE aid=1');
    const banned=publish('regular','persistent',101);
    assert.equal(banned.metrics.xp.overall[0].n,239);
    db.exec('UPDATE player_profiles SET confirmed_banned=0 WHERE aid=1');
    assert.deepEqual(publish('regular','persistent',102),original);
    assert.deepEqual(payload(db,'pve'),pve);
    db.exec('UPDATE progression_intervals SET score_version=0,tempo_score=-1');
    assert.deepEqual(publish('regular','persistent',103),original);
    assert.ok(scores(db).filter(row=>row.score_version!==0).length>0);
    const s1=publish('seasonal','s1',100),s2=publish('seasonal','s2',100);
    assert.deepEqual(s1.metrics,s2.metrics);
    db.exec("UPDATE progression_snapshots SET experience=999999 WHERE mode='seasonal' AND cycle_id='s2'");
    assert.notDeepEqual(publish('seasonal','s2',101).metrics.xp,s1.metrics.xp);
    assert.deepEqual(payload(db,'seasonal','s1'),s1);
    assertNoStage(db);
  } finally {db.close();}
});

test('process exit during staging or publication commit leaves the last complete generation readable',()=> {
  const directory=mkdtempSync(join(tmpdir(),'progression-crash-'));
  const file=join(directory,'progression.db');
  let db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');seed(db);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    const before=payload(db);
    db.close();db=null;
    for(const phase of ['staging','commit']) {
      const code=`import {DatabaseSync} from 'node:sqlite';
        import {materializeSqlitePopulationSnapshot as publish} from './lib/seasonal/progression-db.ts';
        const db=new DatabaseSync(process.argv[1]);
        const audited={exec:sql=>db.exec(sql),prepare(sql) {
          const stmt=db.prepare(sql);
          return Object.fromEntries(['run','get','all','iterate'].map(method=>[method,(...args)=>{
            const result=stmt[method](...args);
            if((method==='run' || method==='get') && (process.argv[2]==='staging'
              ? sql.startsWith('CREATE TEMP TABLE progression_population_snapshot_source')
              : sql.startsWith('INSERT INTO progression_population_generations'))) process.exit(9);
            return result;
          }]));
        }};
        publish(audited,'regular','persistent',101);`;
      assert.throws(()=>execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,file,phase],
        {timeout:30000,stdio:'pipe'}),error=>error.status===9);
      db=new DatabaseSync(file);
      assert.deepEqual(payload(db),before);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
      db.close();db=null;
    }
    db=new DatabaseSync(file);
    materializeSqlitePopulationSnapshot(db,'regular','persistent',101);
    assert.deepEqual(payload(db),before);
  } finally {db?.close();rmSync(directory,{recursive:true,force:true});}
});


test('replacing the source file at the same path and timestamp cannot reuse the previous source rows',()=> {
  const directory=mkdtempSync(join(tmpdir(),'progression-replacement-'));
  const file=join(directory,'progression.db');
  const code=`import {DatabaseSync} from 'node:sqlite';
    import {initializeSeasonalSchema} from './lib/seasonal/storage.ts';
    import {refreshSqliteProgressionAggregates} from './lib/seasonal/daily-aggregates.ts';
    import {materializeSqlitePopulationSnapshot} from './lib/seasonal/progression-db.ts';
    ${seed.toString()}
    const db=new DatabaseSync(process.argv[1]);seed(db);
    if(process.argv[2]==='replacement') db.exec('UPDATE progression_snapshots SET experience=experience+1000');
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    console.log(db.prepare('SELECT payload FROM progression_population_generations').get().payload);
    db.close();`;
  const run=kind=>JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,file,kind],
    {timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  try {
    const before=run('original');
    renameSync(file,join(directory,'previous.db'));
    const after=run('replacement');
    assert.notDeepEqual(after.metrics.xp,before.metrics.xp);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('HTTP reads of the published average keep responding during the isolated materializer',async(t)=> {
  const directory=mkdtempSync(join(tmpdir(),'progression-http-'));
  const file=join(directory,'progression.db');
  const db=new DatabaseSync(file);
  let child;
  try {
    db.exec('PRAGMA journal_mode=WAL');seed(db);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    child=fork(new URL('./fixtures/progression-http-probe.mjs',import.meta.url),[file],{stdio:['ignore','pipe','pipe','ipc']});
    let readyResolve,readyReject,doneResolve,doneReject;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
    // Child startup failures can reject before the ready handshake resolves.
    void done.catch(()=>{});
    let settled=false;
    child.on('message',message=>{
      if(message.ready) readyResolve();
      else {settled=true;if(message.error){const error=new Error(message.error);readyReject(error);doneReject(error);}else doneResolve(message.samples);}
    });
    child.on('error',error=>{readyReject(error);doneReject(error);});
    child.on('exit',code=>{if(!settled){const error=new Error('probe exited '+code);readyReject(error);doneReject(error);}});
    await ready;
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',101);
    child.send('stop');
    const samples=await done;
    assert.ok(samples.length>0);
    t.diagnostic('synthetic HTTP reader: '+samples.length+' successful responses, max '+Math.max(...samples).toFixed(1)+'ms');
    await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    child=null;
  } finally {
    if(child && child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
    db.close();rmSync(directory,{recursive:true,force:true});
  }
});


test('clock rollback cannot select a retained old payload with the same timestamp',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    seed(db);refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    const first=payload(db);
    db.exec('UPDATE progression_snapshots SET experience=experience+1000');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',200);
    db.exec('UPDATE progression_snapshots SET experience=experience+2000');
    const result=materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    assert.ok(result.generation>200);
    assert.equal(result.generatedAt,100);
    assert.notDeepEqual(payload(db).metrics.xp,first.metrics.xp);
    assert.equal(payload(db).metrics.xp.overall[0].value,first.metrics.xp.overall[0].value+3000);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM progression_population_generations').get().n,2);
  } finally {db.close();}
});

for(const phase of ['aggregate','population']) test(`${phase}: a later completed job cannot be replaced by an older build`,()=> {
  const directory=mkdtempSync(join(tmpdir(),'progression-newer-job-'));
  const file=join(directory,'progression.db');
  const db=new DatabaseSync(file);
  let writer;
  try {
    db.exec('PRAGMA journal_mode=WAL');seed(db);
    refreshSqliteProgressionAggregates(db,'regular','persistent');
    materializeSqlitePopulationSnapshot(db,'regular','persistent',100);
    writer=new DatabaseSync(file);
    let newer,called=false;
    const audited=wrap(db,{after(sql,method) {
      const trigger=phase==='aggregate' ? sql.startsWith('CREATE TEMP TABLE progression_interval_source')
        : sql.startsWith('CREATE TEMP TABLE progression_population_snapshot_source');
      if(method!=='run' || !trigger || called) return;
      called=true;
      writer.exec('UPDATE progression_snapshots SET experience=experience+1000');
      refreshSqliteProgressionAggregates(writer,'regular','persistent');
      materializeSqlitePopulationSnapshot(writer,'regular','persistent',120);
      newer=payload(writer);
    }});
    if(phase==='aggregate') refreshSqliteProgressionAggregates(audited,'regular','persistent');
    else {
      const result=materializeSqlitePopulationSnapshot(audited,'regular','persistent',110);
      assert.equal(result.generation,120);
    }
    assert.ok(called);
    assert.deepEqual(payload(db),newer);
    assertNoStage(db);
  } finally {writer?.close();db.close();rmSync(directory,{recursive:true,force:true});}
});

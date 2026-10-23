import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TEMPO_IDS as ids, TEMPO_TRANSITIONS, TEMPO_TTL_MS, parseTempoUnlocks, measureTempo, evaluateTempo } from "../lib/achievement-tempo.ts";
import { initializeTempoExclusions, materializeTempo, readTempoReport, tempoExclusions } from "../lib/achievement-tempo-store.ts";

const now = Date.parse("2026-10-23T12:00:00Z"), day = 86_400_000;
const scope = { mode: "regular", cycleId: "persistent", startsAt: 0, endsAt: null };
const start = Date.parse("2026-06-01T00:00:00Z");
const unlocks = (times) => ({ times, invalid: [], malformed: false });
const measurement = (days) => ({ key: "ultra1", fromAt: start, toAt: start + days * day, days, reason: null });

test("dates use seconds or milliseconds, preserve ownership without dates, and reject conflicts and malformed data", () => {
  assert.equal(parseTempoUnlocks(JSON.stringify({ achievementUnlocks: { [ids[0]]: start / 1000 } }), JSON.stringify({ [ids[0]]: start }), now).times[ids[0]], start);
  assert.deepEqual(parseTempoUnlocks("{}", JSON.stringify([ids[0]]), now), unlocks({}));
  assert.equal(parseTempoUnlocks("{}", JSON.stringify([{ id: ids[0], unlockedAt: start }]), now).times[ids[0]], start);
  const conflict = parseTempoUnlocks(JSON.stringify({ achievementUnlocks: { [ids[0]]: start } }), JSON.stringify({ [ids[0]]: start + 1 }), now);
  assert.deepEqual(conflict.invalid, [ids[0]]);
  assert.equal(conflict.times[ids[0]], undefined);
  for (const value of [true, false, 0, -1, "", "bad", now + 1]) {
    assert.deepEqual(parseTempoUnlocks(JSON.stringify({ achievementUnlocks: { [ids[0]]: value } }), null, now).invalid, [ids[0]]);
  }
  for (const value of ["{", "null", "[]", '{"achievementUnlocks":[]}']) assert.equal(parseTempoUnlocks(value, null, now).malformed, true);
});

test("period boundaries apply to both dates, with explicit reasons and no zero substitution", () => {
  const boundary = TEMPO_TRANSITIONS[0].since;
  assert.equal(measureTempo(unlocks({ [ids[0]]: boundary, [ids[1]]: boundary + day }), scope)[0].days, 1);
  assert.equal(measureTempo(unlocks({ [ids[0]]: boundary - 1, [ids[1]]: boundary + day }), scope)[0].reason, "outside_period");
  assert.equal(measureTempo(unlocks({ [ids[0]]: start }), scope)[0].reason, "missing_dates");
  assert.equal(measureTempo(unlocks({ [ids[0]]: start, [ids[1]]: start }), scope)[0].reason, "equal_dates");
  assert.equal(measureTempo(unlocks({ [ids[0]]: start + day, [ids[1]]: start }), scope)[0].reason, "reversed_dates");
  const seasonal = { ...scope, mode: "seasonal", startsAt: start, endsAt: start + 3 * day };
  assert.equal(measureTempo(unlocks({ [ids[0]]: start, [ids[1]]: start + 3 * day }), seasonal)[0].reason, "outside_period");
  assert.equal(measureTempo(unlocks({ [ids[0]]: start, [ids[1]]: start + day }), scope, [{ from: start + day, to: start + 2 * day }])[0].reason, "event_overlap");
  assert.equal(measureTempo(unlocks({ [ids[0]]: start, [ids[1]]: start + day }), scope, [{ from: start - day, to: start }])[0].reason, null);
});

test("a contradictory chain cannot become a fast signal, and seasonal prestiges remain unverified", () => {
  const times = { [ids[0]]: start, [ids[1]]: start + 4 * day, [ids[2]]: start + 2 * day };
  assert.equal(measureTempo(unlocks(times), scope)[2].reason, "invalid_dates");
  const prestige = Object.fromEntries(ids.slice(3).map((id, i) => [id, start + i * day]));
  assert.equal(measureTempo(unlocks(prestige), scope)[3].days, 1);
  for (const item of measureTempo(unlocks(prestige), { ...scope, mode: "seasonal" }).slice(3)) assert.equal(item.reason, "seasonal_prestige_unverified");
  prestige[ids[5]] = prestige[ids[4]];
  assert.equal(measureTempo(unlocks(prestige), scope)[3].reason, "invalid_dates");
});

test("leave-one-out quantiles and inclusive ranks match an independent full-array calculation, including ties", () => {
  const values = Array.from({ length: 601 }, (_, i) => [Math.floor(i / 3) + 1, i + 1]);
  const cohort = { key: "ultra1", values, omitted: {} };
  for (const aid of [1, 2, 15, 300, 600, 601, 900]) {
    for (const days of [0.5, 1, 5, 100, 201, 900]) {
      const result = evaluateTempo(measurement(days), cohort, aid);
      const peers = values.filter((value) => value[1] !== aid).map(([n]) => n);
      const q = (p) => peers[Math.ceil(peers.length * p) - 1];
      assert.equal(result.n, peers.length);
      assert.equal(result.median, q(0.5)); assert.equal(result.p5, q(0.05)); assert.equal(result.p1, q(0.01));
      assert.equal(result.percentile, peers.filter((value) => value <= days).length / peers.length * 100);
    }
  }
  const same = { ...cohort, values: values.map(([, id]) => [5, id]) };
  assert.equal(evaluateTempo(measurement(5), same, 1).signal, "typical");
  assert.equal(evaluateTempo(measurement(5), same, 1).percentile, 100);
  assert.equal(evaluateTempo(measurement(0.1), { ...cohort, values: values.slice(0, 100) }, 1).reason, "insufficient_sample");
  assert.equal(evaluateTempo(measurement(0.1), { ...cohort, values: values.slice(0, 500) }, 1).p1, null);
});

export function fixture(count = 120) {
  const source = new DatabaseSync(":memory:"), output = new DatabaseSync(":memory:");
  source.exec(`CREATE TABLE player_profiles(mode TEXT, cycle_id TEXT, aid INTEGER, confirmed_banned INTEGER DEFAULT 0, PRIMARY KEY(mode,cycle_id,aid));
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY, reason TEXT, created_at INTEGER);
    CREATE TABLE progression_personal_revisions(mode TEXT, cycle_id TEXT, aid INTEGER, revision INTEGER, PRIMARY KEY(mode,cycle_id,aid));
    CREATE TABLE progression_snapshots(id INTEGER PRIMARY KEY, mode TEXT, cycle_id TEXT, aid INTEGER, profile_updated_at INTEGER, stats_json TEXT, achievements TEXT);
    CREATE INDEX idx_snapshot ON progression_snapshots(mode,cycle_id,aid,profile_updated_at DESC,id DESC);`);
  for (let aid = 1; aid <= count; aid++) {
    source.prepare("INSERT INTO player_profiles VALUES ('regular','persistent',?,0)").run(aid);
    source.prepare("INSERT INTO progression_personal_revisions VALUES ('regular','persistent',?,1)").run(aid);
    source.prepare("INSERT INTO progression_snapshots VALUES (?, 'regular', 'persistent', ?, ?, ?, NULL)").run(aid, aid, now, JSON.stringify({ achievementUnlocks: {
      [ids[0]]: start, [ids[1]]: start + day, [ids[2]]: start + (2 + aid % 100) * day,
    } }));
  }
  initializeTempoExclusions(source);
  return { source, output, close() { output.close(); source.close(); } };
}

test("publication uses one latest profile per identity, excludes all known bans, and decodes only changed profiles", () => {
  const db = fixture();
  try {
    db.source.exec("INSERT INTO excluded_players VALUES(1,'manual',1); INSERT INTO player_profiles VALUES('seasonal','cycle',2,1)");
    const initial = materializeTempo(db.source, db.output, scope, { now });
    assert.equal(initial.profiles, 118); assert.equal(initial.decoded, 120);
    const report = readTempoReport(db.source, db.output, scope, 3, now);
    assert.equal(report.available, true); assert.equal(report.affectsPublicRisk, false);
    assert.equal(report.evaluations[2].n, 117);
    assert.equal(report.cohorts[2].n, 118);
    assert.equal(report.cohorts[2].examples.includes(1), false);
    const cached = materializeTempo(db.source, db.output, scope, { now: now + 1 });
    assert.equal(cached.skipped, true);
    const repeated = materializeTempo(db.source, db.output, scope, { now, force: true });
    assert.equal(repeated.decoded, 0);
    db.source.exec("UPDATE progression_personal_revisions SET revision=2 WHERE aid=3");
    assert.equal(materializeTempo(db.source, db.output, scope, { now, force: true }).decoded, 1);
    assert.equal(readTempoReport(db.source, db.output, scope, 9999, now).observedAt, null);
    assert.equal(readTempoReport(db.source, db.output, scope, 3, now + 3 * TEMPO_TTL_MS).reason, "publication_expired");
  } finally { db.close(); }
});

test("ban and restoration invalidate immediately; stable initialization never invalidates or resets revisions", () => {
  const db = fixture();
  try {
    materializeTempo(db.source, db.output, scope, { now });
    const revision = tempoExclusions(db.source);
    initializeTempoExclusions(db.source);
    assert.equal(tempoExclusions(db.source), revision);
    db.source.exec("INSERT INTO excluded_players VALUES(1,'manual',1)");
    assert.equal(readTempoReport(db.source, db.output, scope, 3, now).reason, "exclusions_changed");
    materializeTempo(db.source, db.output, scope, { now: now + 1 });
    assert.equal(readTempoReport(db.source, db.output, scope, 3, now + 1).cohorts[2].n, 119);
    db.source.exec("DELETE FROM excluded_players WHERE aid=1");
    assert.equal(readTempoReport(db.source, db.output, scope, 3, now + 1).reason, "exclusions_changed");
    materializeTempo(db.source, db.output, scope, { now: now + 2 });
    db.source.exec("UPDATE player_profiles SET confirmed_banned=1 WHERE aid=2");
    assert.equal(readTempoReport(db.source, db.output, scope, 3, now + 2).reason, "exclusions_changed");
    materializeTempo(db.source, db.output, scope, { now: now + 3 });
    db.source.exec("UPDATE player_profiles SET confirmed_banned=0 WHERE aid=2");
    assert.equal(readTempoReport(db.source, db.output, scope, 3, now + 3).reason, "exclusions_changed");
  } finally { db.close(); }
});

test("failed publication and deadline retain the previous generation and normalized profiles atomically", () => {
  const db = fixture();
  try {
    materializeTempo(db.source, db.output, scope, { now });
    const before = db.output.prepare("SELECT payload FROM achievement_tempo_publications").get().payload;
    const oldProfile = db.output.prepare("SELECT unlocks_json FROM achievement_tempo_profiles WHERE aid=3").get().unlocks_json;
    db.source.prepare("UPDATE progression_snapshots SET stats_json='{}' WHERE aid=3").run();
    db.source.exec("UPDATE progression_personal_revisions SET revision=2 WHERE aid=3");
    db.output.exec("CREATE TRIGGER fail_publish BEFORE UPDATE ON achievement_tempo_publications BEGIN SELECT RAISE(ABORT,'test_failure'); END");
    assert.throws(() => materializeTempo(db.source, db.output, scope, { now, force: true }), /test_failure/);
    assert.equal(db.output.prepare("SELECT payload FROM achievement_tempo_publications").get().payload, before);
    assert.equal(db.output.prepare("SELECT unlocks_json FROM achievement_tempo_profiles WHERE aid=3").get().unlocks_json, oldProfile);
    db.output.exec("DROP TRIGGER fail_publish");
    assert.throws(() => materializeTempo(db.source, db.output, scope, { now, force: true, deadline: Date.now() - 1 }), /tempo_deadline/);
    assert.equal(db.output.prepare("SELECT payload FROM achievement_tempo_publications").get().payload, before);
    assert.equal(materializeTempo(db.source, db.output, scope, { now, force: true }).decoded, 1);
  } finally { db.close(); }
});

test("mode and cycle publications stay separate and a rolled-back ban does not invalidate them", () => {
  const db = fixture();
  try {
    db.source.exec(`INSERT INTO player_profiles SELECT 'seasonal','s1',aid,0 FROM player_profiles WHERE mode='regular';
      INSERT INTO progression_personal_revisions SELECT 'seasonal','s1',aid,1 FROM player_profiles WHERE mode='regular';
      INSERT INTO progression_snapshots SELECT id+1000,'seasonal','s1',aid,profile_updated_at,stats_json,achievements FROM progression_snapshots WHERE mode='regular';`);
    const seasonal = { mode: "seasonal", cycleId: "s1", startsAt: start, endsAt: null };
    materializeTempo(db.source, db.output, scope, { now });
    materializeTempo(db.source, db.output, seasonal, { now });
    const regular = readTempoReport(db.source, db.output, scope, 3, now);
    const season = readTempoReport(db.source, db.output, seasonal, 3, now);
    assert.equal(regular.cohorts[0].n, 120); assert.equal(season.cohorts[0].n, 120);
    assert.equal(regular.evaluations[0].n, 119); assert.equal(season.evaluations[0].n, 119);
    assert.equal(season.evaluations[3].reason, "seasonal_prestige_unverified");
    assert.equal(readTempoReport(db.source, db.output, { ...seasonal, cycleId: "s2" }, 3, now).reason, "not_published");
    assert.equal(readTempoReport(db.source, db.output, { ...seasonal, startsAt: start + 1 }, 3, now).reason, "not_published");
    db.source.exec("BEGIN; INSERT INTO excluded_players VALUES(3,'manual',1); ROLLBACK");
    assert.equal(readTempoReport(db.source, db.output, seasonal, 3, now).available, true);
  } finally { db.close(); }
});

test("a rebuilt source with reused personal revisions discards old normalized dates and identities", () => {
  const original = fixture(), replacement = fixture();
  try {
    materializeTempo(original.source, original.output, scope, { now });
    replacement.source.exec("DELETE FROM player_profiles WHERE aid=120");
    replacement.source.prepare("UPDATE progression_snapshots SET stats_json=? WHERE aid=1").run(JSON.stringify({ achievementUnlocks: {
      [ids[0]]: start, [ids[1]]: start + 10 * day, [ids[2]]: start + 20 * day,
    } }));
    assert.equal(readTempoReport(replacement.source, original.output, scope, 1, now).reason, "exclusions_changed");
    assert.equal(materializeTempo(replacement.source, original.output, scope, { now }).decoded, 119);
    const report = readTempoReport(replacement.source, original.output, scope, 1, now);
    assert.equal(report.evaluations[0].days, 10);
    assert.equal(report.evaluations[2].days, 20);
    assert.equal(readTempoReport(replacement.source, original.output, scope, 120, now).observedAt, null);
  } finally { replacement.close(); original.close(); }
});

test("dates after the saved snapshot are unavailable and a model upgrade decodes the old cache again", () => {
  const db = fixture();
  try {
    materializeTempo(db.source, db.output, scope, { now });
    const payload = JSON.parse(db.output.prepare("SELECT payload FROM achievement_tempo_publications").get().payload);
    payload.version = 0;
    db.output.prepare("UPDATE achievement_tempo_publications SET payload=?").run(JSON.stringify(payload));
    // Keep personal revision unchanged to ensure the incompatible model forces a decode.
    db.source.prepare("UPDATE progression_snapshots SET profile_updated_at=? WHERE aid=3").run(start - day);
    assert.equal(materializeTempo(db.source, db.output, scope, { now, force: true }).decoded, 120);
    const report = readTempoReport(db.source, db.output, scope, 3, now);
    assert.equal(report.evaluations[0].reason, "invalid_dates");
    assert.equal(report.evaluations[0].signal, "unavailable");
    assert.equal(report.evaluations[0].days, null);
    assert.equal(report.cohorts[0].n, 119);
  } finally { db.close(); }
});

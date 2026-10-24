import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { axisMatchRosterFingerprintForMatch } from "../lib/axis-match-submission.ts";

function makeMatch(number = 77) {
  return {
    number,
    time: Date.now(),
    queueId: "1343726040421367842",
    queue: "Arena League",
    maps: [],
    winner: 0,
    teams: [0, 1].map(teamIndex => ({
      name: null,
      players: Array.from({ length: 5 }, (_, index) => {
        const rosterIndex = teamIndex * 5 + index;
        return {
          id: String(1000 + rosterIndex),
          name: `Player ${rosterIndex + 1}`,
          mmr: 1000,
          change: 1,
          profile: null,
        };
      }),
    })),
  };
}

function photo(letter, value = 1) {
  return { revision: letter.repeat(64), width: 1, height: 1, data: new Uint8Array([value, value + 1, value + 2]) };
}

function kda(kills) {
  return { kills, deaths: 1, assists: 0 };
}

function allPlayers(match) {
  return match.teams.flatMap(team => team.players);
}

function changesFor(players, start = 1) {
  return players.map((player, index) => ({ discordId: player.id, kda: kda(start + index), expected: null }));
}

function evidenceFor(match, missingDiscordIds = []) {
  return {
    recognizedNames: allPlayers(match).map(player => player.name),
    unmatchedNames: [],
    missingDiscordIds,
  };
}

function openStore(path = ":memory:", match = makeMatch()) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000");
  const store = createAxisLeagueStore(db);
  store.publishArchive({ page: 1, pages: 1, total: 1, matches: [match] });
  return { db, store, match };
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

async function runConcurrentSubmissions(dbPath, match, specs) {
  const workers = specs.map(spec => new Worker(new URL(import.meta.url), {
    workerData: {
      mode: "submit",
      dbPath,
      match,
      fingerprint: axisMatchRosterFingerprintForMatch(match),
      ...spec,
    },
  }));
  try {
    await Promise.all(workers.map(worker => waitForWorkerMessage(worker, "ready")));
    for (const worker of workers) worker.postMessage({ type: "go" });
    const results = await Promise.all(workers.map(worker => waitForWorkerMessage(worker, "done")));
    for (const result of results) assert.equal(result.ok, true, result.error);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

function submitInStore(store, match, revision, input, missingDiscordIds = []) {
  return store.submitAxisMatch(
    match.number,
    photo(revision),
    input,
    undefined,
    evidenceFor(match, missingDiscordIds),
    { sub: "uploader", name: "Uploader" },
    axisMatchRosterFingerprintForMatch(match),
  );
}

if (!isMainThread && workerData?.mode === "submit") {
  const db = new DatabaseSync(workerData.dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const store = createAxisLeagueStore(db);
  parentPort.postMessage({ type: "ready" });
  await new Promise(resolve => parentPort.once("message", resolve));
  try {
    store.submitAxisMatch(
      workerData.match.number,
      { ...workerData.photo, data: new Uint8Array(workerData.photo.data) },
      workerData.input,
      undefined,
      workerData.evidence,
      workerData.actor,
      workerData.fingerprint,
    );
    parentPort.postMessage({ type: "done", ok: true });
  } catch (error) {
    parentPort.postMessage({ type: "done", ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    db.close();
  }
} else if (isMainThread) {
  test("simultaneous SQLite workers merge complementary KDA and preserve both photos", async t => {
    const directory = mkdtempSync(join(tmpdir(), "axis-submission-workers-"));
    const dbPath = join(directory, "axis.sqlite");
    const { db, match } = openStore(dbPath);
    db.close();
    let checkDb;
    let store;
    t.after(() => {
      try { checkDb?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    const players = allPlayers(match);
    await runConcurrentSubmissions(dbPath, match, [
      {
        photo: photo("a", 1),
        input: changesFor(players.slice(0, 5)),
        evidence: evidenceFor(match, players.slice(5).map(player => player.id)),
        actor: { sub: "worker-a", name: "Worker A" },
      },
      {
        photo: photo("b", 4),
        input: changesFor(players.slice(5), 6),
        evidence: evidenceFor(match, players.slice(0, 5).map(player => player.id)),
        actor: { sub: "worker-b", name: "Worker B" },
      },
    ]);

    ({ db: checkDb, store } = openStore(dbPath, match));
    assert.equal(store.readMatchKda(match.number).size, 10);
    assert.equal(checkDb.prepare("SELECT COUNT(*) AS n FROM axis_match_submissions WHERE match_number=?").get(match.number).n, 2);
    const review = store.readAxisMatchReview(match.number);
    assert.equal(review.submissions.length, 2);
    assert.equal(review.missingStats.length, 0);
    assert.deepEqual(new Set(review.submissions.flatMap(submission => submission.missingDiscordIds)), new Set(players.map(player => player.id)));
    assert.ok(["a", "b"].includes(store.readMatchPhotoMetadata(match.number).revision[0]));
  });

  test("retrying a photo after moderator deletion does not restore its KDA", t => {
    const { db, store, match } = openStore();
    t.after(() => db.close());
    const player = match.teams[0].players[0];
    const input = [{ discordId: player.id, kda: kda(7), expected: null }];
    submitInStore(store, match, "a", input);
    store.setMatchStats(match.number, [{ discordId: player.id, kda: null, expected: kda(7) }], undefined, undefined, { sub: "moderator", name: "Moderator" });
    assert.equal(store.readMatchKda(match.number).has(player.id), false);

    const retry = submitInStore(store, match, "a", input);
    assert.equal(retry.conflicts.length, 0);
    assert.equal(store.readMatchKda(match.number).has(player.id), false);
    assert.equal(store.readAxisMatchReview(match.number).submissions.length, 1);
  });

  test("role assignment rolls back both tables when the second write aborts", t => {
    const { db, store } = openStore();
    t.after(() => db.close());
    db.exec("CREATE TRIGGER fail_axis_role BEFORE INSERT ON axis_kda_editors BEGIN SELECT RAISE(ABORT, 'forced role rollback'); END");
    assert.throws(() => store.setAxisRole("rollback-user", "moderator"), /forced role rollback/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_roles WHERE google_sub=?").get("rollback-user").n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_kda_editors WHERE google_sub=?").get("rollback-user").n, 0);
  });

  test("submission rolls back KDA, evidence and primary photo on a later write failure", t => {
    const { db, store, match } = openStore();
    t.after(() => db.close());
    const player = match.teams[0].players[0];
    const input = [{ discordId: player.id, kda: kda(3), expected: null }];
    db.exec("CREATE TRIGGER fail_axis_primary_photo BEFORE INSERT ON axis_match_photos BEGIN SELECT RAISE(ABORT, 'forced photo rollback'); END");
    assert.throws(() => submitInStore(store, match, "a", input), /forced photo rollback/);
    assert.equal(store.readMatchKda(match.number).size, 0);
    assert.equal(store.readMatchPhoto(match.number), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_submissions WHERE match_number=?").get(match.number).n, 0);

    db.exec("DROP TRIGGER fail_axis_primary_photo");
    db.exec("CREATE TRIGGER fail_axis_submission BEFORE INSERT ON axis_match_submissions BEGIN SELECT RAISE(ABORT, 'forced evidence rollback'); END");
    assert.throws(() => submitInStore(store, match, "b", input), /forced evidence rollback/);
    assert.equal(store.readMatchKda(match.number).size, 0);
    assert.equal(store.readMatchPhoto(match.number), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_submissions WHERE match_number=?").get(match.number).n, 0);
  });

  test("replacement keeps a pre-submission primary photo as reviewable evidence", t => {
    const { db, store, match } = openStore();
    t.after(() => db.close());
    const legacy = photo("a", 1);
    store.setMatchPhoto(match.number, null, legacy);
    submitInStore(store, match, "b", [
      { discordId: match.teams[0].players[0].id, kda: kda(4), expected: null },
    ]);
    assert.equal(store.readMatchPhotoMetadata(match.number).revision, photo("b").revision);
    assert.equal(store.readAxisMatchSubmissionPhoto(match.number, legacy.revision).revision, legacy.revision);
    const review = store.readAxisMatchReview(match.number);
    assert.deepEqual(review.submissions.map(submission => submission.photoRevision).sort(), [photo("a").revision, photo("b").revision].sort());
    assert.equal(review.submissions.find(submission => submission.photoRevision === legacy.revision).uploadedBy, "legacy");
  });

  test("stale roster fingerprint rejects the submission without partial writes", t => {
    const { db, store, match } = openStore();
    t.after(() => db.close());
    const fingerprint = axisMatchRosterFingerprintForMatch(match);
    const changedMatch = structuredClone(match);
    changedMatch.teams[0].players[0].name = "Changed after OCR";
    store.publishArchive({ page: 1, pages: 1, total: 1, matches: [changedMatch] });
    assert.throws(() => store.submitAxisMatch(
      match.number,
      photo("a"),
      [{ discordId: match.teams[0].players[0].id, kda: kda(8), expected: null }],
      undefined,
      evidenceFor(match),
      { sub: "stale", name: "Stale" },
      fingerprint,
    ), /roster changed/);
    assert.equal(store.readMatchKda(match.number).size, 0);
    assert.equal(store.readMatchPhoto(match.number), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_submissions WHERE match_number=?").get(match.number).n, 0);
  });

  test("review metadata selects do not pull private image BLOBs", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA busy_timeout=5000");
    const queries = [];
    const tracedDb = {
      exec: sql => db.exec(sql),
      prepare: sql => { queries.push(String(sql)); return db.prepare(sql); },
    };
    const match = makeMatch();
    const store = createAxisLeagueStore(tracedDb);
    store.publishArchive({ page: 1, pages: 1, total: 1, matches: [match] });
    store.setMatchPhoto(match.number, null, photo("a"));
    const review = store.readAxisMatchReview(match.number);
    db.close();
    assert.equal(review.submissions.length, 1);
    const reviewSelects = queries.filter(query => /SELECT[\s\S]+FROM axis_match_submissions/i.test(query));
    assert.ok(reviewSelects.length > 0);
    assert.ok(reviewSelects.every(query => !/SELECT\s+\*/i.test(query) && !/SELECT[\s\S]*\bdata\b[\s\S]*FROM axis_match_submissions/i.test(query)));
  });
}

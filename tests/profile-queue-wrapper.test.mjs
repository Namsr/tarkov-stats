import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The queue driver is server-local (/usr/local/sbin/tarkovstats-profile-queue)
// and deploys manually, so the repo copy is pinned by structure, not by
// execution. These assertions keep the versioned copy faithful to the live
// wrapper while enforcing the B3 failure-isolation contract.
test("versioned profile queue keeps the live steps, order and budgets", async () => {
  const source = await readFile("ops/profile-queue.sh", "utf8");
  const stepScripts = [
    "scripts/warmup-leaderboard-profiles.mjs",
    "scripts/sync-regular-profiles.mjs",
    "scripts/sync-pve-profiles.mjs",
    "scripts/sync-arena-profiles.mjs",
    "scripts/sync-seasonal-profiles.mjs",
  ];
  let previous = -1;
  for (const script of stepScripts) {
    const at = source.indexOf(script);
    assert.ok(at > previous, `${script} runs in the live order`);
    previous = at;
  }
  assert.match(source, /LEADERBOARD_WARMUP_MAX_PROFILES=100000/);
  assert.match(source, /REGULAR_PROFILE_SYNC_RPS=1/);
  assert.match(source, /PVE_PROFILE_SYNC_RPS=1/);
  assert.match(source, /ARENA_PROFILE_SYNC_RPS=1/);
  assert.match(source, /SEASONAL_FEED_RPS=1/);
  assert.match(source, /docker compose -p tarkovstats -f docker-compose\.vps\.yml exec -T/);
  assert.match(source, /cd \/opt\/tarkovstats-auto/);
});

test("versioned profile queue isolates mode failures instead of aborting", async () => {
  const source = await readFile("ops/profile-queue.sh", "utf8");
  assert.match(source, /^set -u$/m);
  assert.doesNotMatch(source, /^set -e$/m);
  assert.doesNotMatch(source, /^set -eu$/m);
  assert.match(source, /MODE_RESULT/);
  assert.match(source, /QUEUE_SUMMARY/);
  assert.match(source, /exit 1/);
  // A failing step must record and continue, never skip the remaining modes.
  assert.match(source, /run_mode regular/);
  assert.match(source, /run_mode seasonal/);
  assert.match(source, /return 0/);
});

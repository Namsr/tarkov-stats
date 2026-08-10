import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("app/api/operator/seasonal/refresh/route.ts", "utf8");

test("Seasonal refresh route uses the seasonal queue and captures only after a live lease", () => {
  assert.match(source, /action === "claim"/);
  assert.match(source, /beginOrResumeProgressionRefreshRun/);
  assert.match(source, /claimNextProgressionRefresh/);
  assert.match(source, /activeProgressionRefreshLease/);
  assert.match(source, /recordProgressionRefreshOutcome/);
  assert.match(source, /fetchSeasonalPayload/);
  assert.match(source, /resolveSeasonalProfile/);
  assert.match(source, /SUCCESSFUL_CAPTURE_STATES/);
  assert.match(source, /const SUCCESSFUL_CAPTURE_STATES = new Set\(\["progression", "duplicate", "reset", "schema_anomaly"\]\)/);
  assert.match(source, /if \(!SUCCESSFUL_CAPTURE_STATES\.has\(result\.capture\.status\)\)/);
  assert.doesNotMatch(source, /profile-refresh|regular-profile|persistRegularProfileSnapshot/);
});

test("Extension points at the private Tarkov Stats API and keeps Tarkov Stats host permission", async () => {
  const manifest = await readFile(".profile-refresh-private/extension/manifest.json", "utf8");
  const config = await readFile(".profile-refresh-private/extension/config.js", "utf8");
  assert.match(manifest, /https:\/\/tarkovstats\.ru\/\*/);
  assert.match(config, /API_PATH = "\/api\/operator\/seasonal\/refresh"/);
});

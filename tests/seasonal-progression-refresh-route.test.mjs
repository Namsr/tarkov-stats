import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("app/api/operator/seasonal/refresh/route.ts", "utf8");

const exists = (path) => access(path).then(() => true, () => false);

test("Seasonal refresh route uses the seasonal queue and captures only after a live lease", () => {
  assert.match(source, /action === "claim"/);
  assert.match(source, /action === "restart"/);
  assert.match(source, /action === "release"/);
  assert.match(source, /beginOrResumeProgressionRefreshRun/);
  assert.match(source, /restartProgressionRefreshRun/);
  assert.match(source, /releaseProgressionRefreshLease/);
  assert.match(source, /claimNextProgressionRefresh/);
  assert.match(source, /activeProgressionRefreshLease/);
  assert.match(source, /recordProgressionRefreshOutcome/);
  assert.match(source, /fetchSeasonalPayload/);
  assert.match(source, /resolveSeasonalProfile/);
  assert.match(source, /SUCCESSFUL_CAPTURE_STATES/);
  assert.match(source, /const SUCCESSFUL_CAPTURE_STATES = new Set\(\[/);
  assert.match(source, /"baseline"/);
  assert.match(source, /"stale"/);
  assert.match(source, /"stored"/);
  assert.match(source, /storedSeasonalVersion/);
  assert.match(source, /result\.status === 404/);
  assert.match(source, /outcome: "not_found"/);
  assert.match(source, /if \(!SUCCESSFUL_CAPTURE_STATES\.has\(result\.capture\.status\)\)/);
  assert.doesNotMatch(source, /profile-refresh|regular-profile|persistRegularProfileSnapshot/);
});

// The extension directory is referenced nowhere else in the repo: nothing
// creates it, and it is neither tracked nor gitignored, so it is absent from
// every clone. Skip instead of ENOENT so the tracked route assertions above
// still run, and so this check still fires for whoever does have the extension
// built locally.
const extensionDir = ".profile-refresh-private/extension";

test("Extension points at the private Tarkov Stats API and keeps Tarkov Stats host permission", {
  skip: await exists(extensionDir) ? false : `${extensionDir} is a local-only build artifact`,
}, async () => {
  const manifest = await readFile(`${extensionDir}/manifest.json`, "utf8");
  const config = await readFile(`${extensionDir}/config.js`, "utf8");
  assert.match(manifest, /https:\/\/tarkovstats\.ru\/\*/);
  assert.match(config, /API_PATH = "\/api\/operator\/seasonal\/refresh"/);
});

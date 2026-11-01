// Production-artifact Arena fixture. Stop via stdin stop/exit; never used by application runtime.
import assert from "node:assert/strict";
import { createUiFixture } from "../tests/fixtures/rust-arena-ui.mjs";
import { assertNativeParity } from "../tests/fixtures/rust-arena-seasonal-data.mjs";
import { serveRustUiFixture } from "./lib/serve-rust-ui-fixture.mjs";
const baseQuery="/api/average?mode=arena&arenaMode=teamFight&statistic=trimmed_mean&dimension=matches&metric=players";
await serveRustUiFixture({
  createFixture:()=>createUiFixture({prefix:"rust-arena-ui-browser-",rows:300}),
  async closePrimary(){const {getArenaBackend}=await import("../lib/db.ts");(await getArenaBackend())?.db.close();},
  selectors:["ARENA_UI_UPSTREAM"],pagePath:"/population/arena",assetPrefix:"_rust/arena",
  event:"rust_arena_browser_ready",dataDescription:"private synthetic300accounts/all5modes",
  warmCacheQueries:[baseQuery+"&minMatches=10",baseQuery],
  assertPayload(body,label){
    assert.equal(body.mode,"arena");assert.equal(body.schemaVersion,5);
    assert.equal(body.sampleN,300,label+" must use the private initialized fixture");assert.equal(body.population.scannedAccounts,300);
    for(const mode of["teamFight","lastHero","checkpoint","blastGang","shootOutDuo"])assert.equal(body.population.playedAccounts[mode],300,label+"/"+mode+" population");
  },
  assertParity:(a,b,query)=>assertNativeParity(a,b,"real Rust/Next browser startup payload: "+query),
});

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findProfileSummary, type ProfileSummaryMode } from "../lib/profile-summary.ts";

const profileRouteSource = await readFile(
  new URL("../app/api/player/profile/route.ts", import.meta.url),
  "utf8",
);

test("profile summary uses regular, PVE, Arena priority and excludes unavailable mode", async () => {
  const calls: ProfileSummaryMode[] = [];
  const summary = await findProfileSummary(42, "pve", async (mode, aid) => {
    calls.push(mode);
    assert.equal(aid, 42);
    return mode === "arena" ? { nickname: "Arena", side: "Bear", prestige: 2 } : null;
  });

  assert.deepEqual(calls, ["regular", "arena"]);
  assert.deepEqual(summary, { nickname: "Arena", side: "Bear", prestige: 2 });
});

test("profile summary stops at the first saved snapshot", async () => {
  const calls: ProfileSummaryMode[] = [];
  const summary = await findProfileSummary(42, "arena", async (mode) => {
    calls.push(mode);
    return { nickname: mode };
  });

  assert.deepEqual(calls, ["regular"]);
  assert.deepEqual(summary, { nickname: "regular" });
});

test("profile summary is absent when no other mode snapshot exists", async () => {
  const summary = await findProfileSummary(42, "arena", async (mode) => {
    if (mode === "regular") throw new Error("store unavailable");
    return null;
  });

  assert.equal(summary, null);
});

test("only mode_profile_unavailable carries the optional profile summary", () => {
  assert.match(
    profileRouteSource,
    /code: "mode_profile_unavailable",[\s\S]*?\.\.\.\(profileSummary \? \{ profileSummary \} : \{\}\)/,
  );
  assert.match(
    profileRouteSource,
    /NextResponse\.json\(\s*\{ error: "Rate limit exceeded" \},\s*\{ status: 429/,
  );
  assert.match(
    profileRouteSource,
    /NextResponse\.json\(\{ error: "Failed to load player profile" \}, \{ status: 503/,
  );
  assert.match(
    profileRouteSource,
    /\{ error: "Failed to fetch player profile" \},\s*\{ status: 502/,
  );
});

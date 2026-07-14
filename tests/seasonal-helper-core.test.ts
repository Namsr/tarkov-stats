/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHelperTaskId,
  signHelperSession,
  verifyHelperCompletion,
  verifyHelperSession,
} from "../lib/seasonal/helper-core.ts";

const secret = { HELPER_COOKIE_SECRET: "a-secure-test-secret-with-32-characters" };
const helperId = "9e1d2b11-90c4-4b49-a57e-24e066f128d2";
const now = 1_790_000_000_000;

const task = {
  id: 7,
  mode: "seasonal" as const,
  cycleId: "season-a",
  aid: 42,
  state: "leased",
  leaseOwner: helperId,
  leasedUntil: now + 60_000,
  previousProfileUpdatedAt: now - 10_000,
};

const profile = {
  mode: "seasonal" as const,
  cycleId: "season-a",
  aid: 42,
  profileUpdatedAt: now,
};

test("task request accepts only one positive integer taskId", () => {
  assert.equal(parseHelperTaskId({ taskId: 7 }), 7);
  for (const forged of [
    null, [], {}, { taskId: 0 }, { taskId: -1 }, { taskId: 7.5 }, { taskId: "7" },
    { taskId: 7, aid: 42 }, { taskId: 7, profile: { aid: 42 } },
  ]) assert.equal(parseHelperTaskId(forged), null);
});

test("anonymous helper cookie is signed and rejects tampering or missing secret", async () => {
  const token = await signHelperSession(helperId, secret);
  assert.equal(await verifyHelperSession(token, secret), helperId);
  assert.equal(await verifyHelperSession(token + "x", secret), null);
  assert.equal(await verifyHelperSession(token, {}), null);
  await assert.rejects(() => signHelperSession(helperId, {}));
});

test("completion is bound to the signed helper and active lease", () => {
  assert.deepEqual(verifyHelperCompletion({
    enabled: true, helperId, task, profile,
    cycleStartsAt: now - 86_400_000, cycleEndsAt: null, now,
  }), { ok: true });
  assert.equal(verifyHelperCompletion({
    enabled: true, helperId: "258947f1-997e-4a6b-a5fa-a3678b932909", task, profile,
    cycleStartsAt: now - 86_400_000, cycleEndsAt: null, now,
  }).ok, false);
  assert.deepEqual(verifyHelperCompletion({
    enabled: true, helperId, task: { ...task, leasedUntil: now - 1 }, profile,
    cycleStartsAt: now - 86_400_000, cycleEndsAt: null, now,
  }), { ok: false, reason: "lease_expired" });
  assert.deepEqual(verifyHelperCompletion({
    enabled: true, helperId, task: { ...task, leasedUntil: now }, profile,
    cycleStartsAt: now - 86_400_000, cycleEndsAt: null, now,
  }), { ok: false, reason: "lease_expired" });
});

test("server verification rejects forged identity and stale or out-of-cycle timestamps", () => {
  const base = { enabled: true, helperId, task, cycleStartsAt: now - 86_400_000, cycleEndsAt: null, now };
  for (const forged of [
    { ...profile, aid: 43 },
    { ...profile, cycleId: "season-b" },
  ]) {
    assert.deepEqual(verifyHelperCompletion({ ...base, profile: forged }), {
      ok: false, reason: "identity_mismatch",
    });
  }
  assert.deepEqual(verifyHelperCompletion({
    ...base, profile: { ...profile, profileUpdatedAt: task.previousProfileUpdatedAt! },
  }), { ok: false, reason: "stale_profile" });
  assert.deepEqual(verifyHelperCompletion({
    ...base, profile: { ...profile, profileUpdatedAt: now - 2 * 86_400_000 },
  }), { ok: false, reason: "invalid_timestamp" });
});

test("completion fails closed when the helper feature is disabled", () => {
  assert.deepEqual(verifyHelperCompletion({
    enabled: false, helperId, task, profile,
    cycleStartsAt: now - 86_400_000, cycleEndsAt: null, now,
  }), { ok: false, reason: "feature_disabled" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { holdFilteredResponse } from "../scripts/lib/persistent-response-gate.mjs";

function harness() {
  const calls = [], listeners = new Map(), requests = new Map();
  const tab = {
    state: { requests },
    on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); },
    async send(method, params) { calls.push({ method, params }); },
  };
  const emit = (id, networkId, url, status = 200) => listeners.get("Fetch.requestPaused")({
    requestId: id, networkId, request: { url }, responseStatusCode: status,
  });
  return { tab, calls, listeners, requests, emit };
}
const filtered = "http://localhost/api/average?mode=pve&min=1094&max=11976";

test("gate holds the real fresh successful response until unchanged continuation and matches its Network identity", async () => {
  const h = harness(), before = new Set(["old"]);
  const gate = await holdFilteredResponse(h.tab, before);
  assert.deepEqual(h.calls[0], { method:"Fetch.enable", params:{ patterns:[{ urlPattern:"*/api/average*", requestStage:"Response" }] } });
  h.emit("old-fetch", "old", filtered);
  h.emit("unfiltered-fetch", "unfiltered", "http://localhost/api/average?mode=pve");
  h.emit("other-fetch", "other", "http://localhost/api/average?mode=regular&min=1");
  h.emit("missing-id", undefined, filtered);
  h.emit("real-fetch", "real-network", filtered);
  assert.equal(gate.pending(), null, "response alone is insufficient without its Network request");
  h.requests.set("real-network", { id:"real-network", url:filtered, finished:true });
  assert.equal(gate.pending(), null, "finished request cannot establish a pending overlap");
  h.requests.get("real-network").finished = false;
  h.requests.get("real-network").url = filtered + "&different=1";
  assert.equal(gate.pending(), null, "network URL must match the intercepted response");
  h.requests.get("real-network").url = filtered;
  const pending = gate.pending();
  assert.equal(pending.networkId, "real-network"); assert.equal(pending.status, 200);
  assert.equal(pending.request.finished, false);
  assert.equal(h.calls.filter(call => call.method === "Fetch.continueRequest").length, 4);
  await gate.close();
  assert.deepEqual(h.calls.at(-2), { method:"Fetch.continueRequest", params:{requestId:"real-fetch"} });
  assert.deepEqual(h.calls.at(-1), { method:"Fetch.disable", params:undefined });
  assert.equal(h.listeners.size, 0);
});

test("non-successful real response fails and cleanup still disables interception", async () => {
  const h = harness(), gate = await holdFilteredResponse(h.tab, new Set());
  h.emit("failed-fetch", "failed", filtered, 500);
  assert.throws(() => gate.pending(), /not successful: 500/);
  await assert.rejects(gate.close(), /not successful: 500/);
  assert.deepEqual(h.calls.slice(-2).map(call => call.method), ["Fetch.continueRequest", "Fetch.disable"]);
  assert.equal(h.listeners.size, 0);
});

test("cleanup without a matching response disables interception, including after a timeout", async () => {
  const h = harness(), gate = await holdFilteredResponse(h.tab, new Set());
  assert.equal(gate.pending(), null);
  await gate.close();
  assert.equal(h.calls.at(-1).method, "Fetch.disable");
  assert.equal(h.listeners.size, 0);
});

test("a failed continuation still disables interception and removes its listener", async () => {
  const h = harness();
  const originalSend = h.tab.send;
  h.tab.send = async (method, params) => {
    await originalSend(method, params);
    if (method === "Fetch.continueRequest") throw new Error("continuation failed");
  };
  const gate = await holdFilteredResponse(h.tab, new Set());
  h.emit("real-fetch", "real-network", filtered);
  await assert.rejects(gate.close(), /continuation failed/);
  assert.equal(h.calls.at(-1).method, "Fetch.disable");
  assert.equal(h.listeners.size, 0);
});

test("failed enable attempts to disable interception and removes its listener", async () => {
  const h = harness(), originalSend = h.tab.send;
  h.tab.send = async (method, params) => {
    await originalSend(method, params);
    if (method === "Fetch.enable") throw new Error("enable failed");
  };
  await assert.rejects(holdFilteredResponse(h.tab, new Set()), /enable failed/);
  assert.deepEqual(h.calls.map(call => call.method), ["Fetch.enable", "Fetch.disable"]);
  assert.equal(h.listeners.size, 0);
});

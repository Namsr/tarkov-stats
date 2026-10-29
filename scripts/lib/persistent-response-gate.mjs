// Functional checks only: pause an actual successful response after the server
// handled a fresh filtered request. Continue it unchanged after the observation.
export async function holdFilteredResponse(tab, before) {
  let held = null, failure = null, closing = false;
  const continuations = new Set();
  const off = tab.on("Fetch.requestPaused", event => {
    const url = new URL(event.request.url);
    const matches = event.networkId && !before.has(event.networkId)
      && url.pathname === "/api/average" && url.searchParams.get("mode") === "pve"
      && Number(url.searchParams.get("min")) > 0;
    if (!closing && !held && matches && event.responseStatusCode === 200) {
      held = { fetchId: event.requestId, networkId: event.networkId, url: event.request.url, status: event.responseStatusCode };
      return;
    }
    if (matches && event.responseStatusCode !== 200) failure = new Error("Filtered average response was not successful: " + (event.responseStatusCode ?? event.responseErrorReason ?? "missing status"));
    const task = tab.send("Fetch.continueRequest", { requestId: event.requestId }).catch(error => { failure ||= error; });
    continuations.add(task); task.finally(() => continuations.delete(task));
  });
  try {
    await tab.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/average*", requestStage: "Response" }] });
  } catch (error) {
    try { await tab.send("Fetch.disable"); } finally { off(); }
    throw error;
  }
  return {
    pending() {
      if (failure) throw failure;
      if (!held) return null;
      const request = tab.state.requests.get(held.networkId);
      if (!request || request.finished || request.canceled || request.url !== held.url) return null;
      return { ...held, request: { ...request } };
    },
    async close() {
      closing = true;
      try {
        if (held) {
          try { await tab.send("Fetch.continueRequest", { requestId: held.fetchId }); }
          catch (error) { failure ||= error; }
        }
        await Promise.all(continuations);
        if (failure) throw failure;
      } finally {
        try { await tab.send("Fetch.disable"); } finally { off(); }
      }
    },
  };
}

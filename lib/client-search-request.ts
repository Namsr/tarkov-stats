/** Retry one interrupted GET, within a single deadline shared by both attempts. */
export async function fetchPlayerSearch(url: string, signal: AbortSignal): Promise<Response> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const request = () => {
    requestSignal.throwIfAborted();
    return fetch(url, { signal: requestSignal, cache: "no-store" });
  };

  try {
    return await request();
  } catch (error) {
    // Fetch rejects with TypeError for a network failure. HTTP responses and
    // cancellations must not trigger an automatic retry.
    if (requestSignal.aborted || !(error instanceof TypeError)) throw error;
  }

  await new Promise<void>((resolve, reject) => {
    requestSignal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(requestSignal.reason);
    };
    const timer = setTimeout(() => {
      requestSignal.removeEventListener("abort", onAbort);
      resolve();
    }, 300);
    requestSignal.addEventListener("abort", onAbort, { once: true });
  });
  return request();
}

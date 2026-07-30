export function progressionFlightKey(mode: string, cycleId: string, aid: number): string {
  return `${mode}\0${cycleId}\0${aid}`;
}

export function singleFlight<K, T>(
  inFlight: Map<K, Promise<T>>,
  key: K,
  load: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = load().finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

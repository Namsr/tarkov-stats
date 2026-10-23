export interface HomeCounterWindow {
  from: number;
  to: number;
  startsAt: number;
  endsAt: number;
}

export const DAY_MS = 86_400_000;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1_000;

/** Yesterday's profile-count change is revealed evenly throughout today (Europe/Moscow). */
export function homeCounterDay(now: number): { startsAt: number; endsAt: number } {
  const startsAt = Math.floor((now + MOSCOW_OFFSET_MS) / DAY_MS) * DAY_MS - MOSCOW_OFFSET_MS;
  return { startsAt, endsAt: startsAt + DAY_MS };
}

export function homeCountAt(counter: HomeCounterWindow, now: number): number {
  const progress = Math.max(0, Math.min(1, (now - counter.startsAt) / (counter.endsAt - counter.startsAt)));
  return Math.floor(counter.from + (counter.to - counter.from) * progress);
}

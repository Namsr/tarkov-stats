/**
 * Shared queue deadline caps the run budget. Collectors bound every in-flight
 * request and every ladder wait by what is left of it, so a request still open
 * at the deadline is aborted rather than allowed to finish. The abort is
 * recoverable: a capture that reached the server anyway is not repeated as a
 * full recapture. The PvE/Regular queue skips rows whose snapshot already
 * reached `feed_updated_at`, and a superseded Seasonal row settles on the cheap
 * `superseded` outcome.
 */
export function remainingRunBudget(maxRunMs, deadline, now = Date.now()) {
  if (deadline == null || deadline === "") return maxRunMs;
  const end = Number(deadline);
  if (!Number.isSafeInteger(end) || end <= 0) throw new Error("PROFILE_QUEUE_DEADLINE_MS must be a positive timestamp");
  return Math.min(maxRunMs, Math.max(0, end - now));
}

export function createTimestampObjectParser(onEntry) {
  let buffer = "";
  let position = 0;
  let state = "start";
  let key = "";

  const skipWhitespace = () => {
    while (/\s/.test(buffer[position] ?? "")) position += 1;
  };

  const readString = () => {
    if (buffer[position] !== '"') throw new Error("expected JSON string");
    for (let end = position + 1; end < buffer.length; end += 1) {
      if (buffer[end] === "\\") {
        end += 1;
        if (end >= buffer.length) return null;
      } else if (buffer[end] === '"') {
        const raw = buffer.slice(position, end + 1);
        position = end + 1;
        return JSON.parse(raw);
      }
    }
    return null;
  };

  const readValue = (final) => {
    if (buffer[position] === '"') return readString();
    const match = buffer.slice(position).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("expected numeric timestamp");
    const end = position + match[0].length;
    if (!final && end === buffer.length) return null;
    position = end;
    return Number(match[0]);
  };

  const parse = (final) => {
    for (;;) {
      skipWhitespace();
      if (position >= buffer.length) break;
      if (state === "done") throw new Error("unexpected data after JSON object");
      if (state === "start") {
        if (buffer[position] !== "{") throw new Error("updated JSON must be an object");
        position += 1;
        state = "key";
      } else if (state === "key") {
        if (buffer[position] === "}") {
          position += 1;
          state = "done";
        } else {
          const value = readString();
          if (value === null) break;
          key = value;
          state = "colon";
        }
      } else if (state === "colon") {
        if (buffer[position] !== ":") throw new Error("expected ':' after account id");
        position += 1;
        state = "value";
      } else if (state === "value") {
        const value = readValue(final);
        if (value === null) break;
        onEntry(key, value);
        state = "comma";
      } else if (state === "comma") {
        if (buffer[position] === ",") {
          position += 1;
          state = "key";
        } else if (buffer[position] === "}") {
          position += 1;
          state = "done";
        } else {
          throw new Error("expected ',' or '}' after timestamp");
        }
      }
    }

    if (position > 0) {
      buffer = buffer.slice(position);
      position = 0;
    }
    if (final) {
      skipWhitespace();
      if (state !== "done" || position !== buffer.length) {
        throw new Error("truncated or invalid updated JSON");
      }
    }
  };

  return {
    append(chunk) {
      buffer += chunk;
      parse(false);
    },
    finish(chunk = "") {
      buffer += chunk;
      parse(true);
    },
  };
}

export function normalizeUpdatedAt(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

export function classifyFeedEntry(savedUpdatedAt, feedUpdatedAt, watermark, overlapMs) {
  if (savedUpdatedAt !== undefined) {
    return feedUpdatedAt > savedUpdatedAt ? "updated" : null;
  }
  if (watermark === null) return null;
  return feedUpdatedAt >= Math.max(0, watermark - overlapMs) ? "new" : null;
}

export function feedCacheSlot(now = Date.now()) {
  return Math.floor(now / (15 * 60_000));
}

export function snapshotTargetVersion(playerUpdatedAt, feedUpdatedAt, snapshotUpdatedAt) {
  const target = Math.max(Number(playerUpdatedAt) || 0, Number(feedUpdatedAt) || 0);
  if (target > 0) return target;
  return snapshotUpdatedAt == null ? 1 : 0;
}

export function summarizeCoverage(totalValue, coveredValue) {
  const coverageTotal = Math.max(0, Number(totalValue) || 0);
  const covered = Math.min(coverageTotal, Math.max(0, Number(coveredValue) || 0));
  const unresolved = coverageTotal - covered;
  const coveragePercent = coverageTotal === 0 || unresolved === 0
    ? 100
    : Math.min(99.9999, Number(((covered / coverageTotal) * 100).toFixed(4)));
  return { coverageTotal, covered, unresolved, coveragePercent };
}

export function envInteger(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function envNumber(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export function log(event, fields = {}) {
  process.stdout.write(`${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
}

export function backoff(attempt) {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

export function retryableError(text, status) {
  const error = new Error(text);
  error.status = status;
  error.retryable = true;
  return error;
}

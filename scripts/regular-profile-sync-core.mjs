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

export function summarizeCoverage(totalValue, coveredValue) {
  const coverageTotal = Math.max(0, Number(totalValue) || 0);
  const covered = Math.min(coverageTotal, Math.max(0, Number(coveredValue) || 0));
  const unresolved = coverageTotal - covered;
  const coveragePercent = coverageTotal === 0 || unresolved === 0
    ? 100
    : Math.min(99.9999, Number(((covered / coverageTotal) * 100).toFixed(4)));
  return { coverageTotal, covered, unresolved, coveragePercent };
}

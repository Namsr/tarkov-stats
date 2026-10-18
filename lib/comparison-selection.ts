import { parseComparisonScope } from "./comparison-scope.ts";
import type { ComparisonScope } from "../types/comparison";

export const COMPARISON_COOKIE = "comparison_selection";
const MAX_AGE = 60 * 60 * 24 * 180;

export interface ComparisonSelection {
  scope: ComparisonScope;
  primary: number | null;
  secondary: number | null;
}

function validAid(aid: number | null): boolean {
  return aid === null || (Number.isSafeInteger(aid) && aid > 0);
}

export function comparisonSelectionParams(selection: ComparisonSelection): URLSearchParams {
  const { scope, primary, secondary } = selection;
  const params = new URLSearchParams({ mode: scope.mode });
  if (scope.mode === "seasonal") params.set("cycle", scope.cycleId);
  if (scope.mode === "arena") params.set("arenaMode", scope.arenaMode);
  if (parseComparisonScope(params, scope.mode === "seasonal" ? scope.cycleId : null).status !== "available"
    || !validAid(primary) || !validAid(secondary)) throw new TypeError("Invalid comparison selection");
  if (primary !== null) params.set("aid", String(primary));
  if (secondary !== null) params.set("vs", String(secondary));
  return params;
}

export function addComparisonPlayer(scope: ComparisonScope, aid: number, saved: ComparisonSelection | null): ComparisonSelection {
  if (!validAid(aid) || aid === null) throw new TypeError("Invalid comparison account id");
  const primary = saved?.primary ?? null;
  const secondary = saved?.secondary ?? null;
  if (aid === primary || aid === secondary) return { scope, primary, secondary };
  return primary === null ? { scope, primary: aid, secondary } : { scope, primary, secondary: aid };
}

function readCookieValue(): string | null {
  const prefix = `${COMPARISON_COOKIE}=`;
  const cookie = document.cookie.split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : null;
}

export function readComparisonSelection(): ComparisonSelection | null {
  if (typeof document === "undefined") return null;
  try {
    const cookie = readCookieValue();
    if (cookie === null) return null;
    const value = decodeURIComponent(cookie);
    if (value.length > 512) return null;
    const params = new URLSearchParams(value);
    const resolution = parseComparisonScope(params, params.get("cycle"));
    if (resolution.status !== "available") return null;
    const readAid = (key: string) => {
      const values = params.getAll(key);
      if (values.length === 0) return null;
      if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) throw new TypeError("Invalid saved account id");
      const aid = Number(values[0]);
      if (!validAid(aid)) throw new TypeError("Invalid saved account id");
      return aid;
    };
    return { scope: resolution.scope, primary: readAid("aid"), secondary: readAid("vs") };
  } catch { return null; }
}

export function saveComparisonSelection(selection: ComparisonSelection): void {
  if (typeof document === "undefined") return;
  try {
    const value = encodeURIComponent(comparisonSelectionParams(selection).toString());
    if (readCookieValue() === value) return;
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${COMPARISON_COOKIE}=${value}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  } catch { /* Navigation still carries the selection when cookies are unavailable. */ }
}

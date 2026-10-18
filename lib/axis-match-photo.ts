export const AXIS_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const AXIS_PHOTO_MAX_PIXELS = 24_000_000;
export const AXIS_PHOTO_MAX_BODY = Math.ceil(AXIS_PHOTO_MAX_BYTES / 3) * 4 + 1024;
export const AXIS_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];

export interface AxisMatchPhoto { revision: string; width: number; height: number }
export interface AxisStoredPhoto extends AxisMatchPhoto { data: Uint8Array }

export class AxisPhotoInputError extends Error {
  readonly status: 400 | 413;
  constructor(status: 400 | 413 = 400) { super("Invalid match photo"); this.status = status; }
}

export function axisPhotoUrl(matchNumber: number, revision: string) {
  return `/api/axis-league/match-photo?match=${matchNumber}&v=${revision}`;
}

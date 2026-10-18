import sharp from "sharp";
import { createHash } from "node:crypto";
import { AXIS_PHOTO_MAX_BODY, AXIS_PHOTO_MAX_BYTES, AXIS_PHOTO_MAX_PIXELS, AxisPhotoInputError, type AxisStoredPhoto } from "./axis-match-photo.ts";

/** Bound the stream too: Content-Length is optional and supplied by the caller. */
export async function readAxisPhotoBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > AXIS_PHOTO_MAX_BODY) throw new AxisPhotoInputError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new AxisPhotoInputError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AXIS_PHOTO_MAX_BODY) { await reader.cancel(); throw new AxisPhotoInputError(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Decode raster input, strip metadata, and retain the original pixels losslessly. */
export async function normalizeAxisPhoto(value: unknown): Promise<AxisStoredPhoto> {
  if (typeof value !== "string" || !value.length) throw new AxisPhotoInputError();
  if (value.length > Math.ceil(AXIS_PHOTO_MAX_BYTES / 3) * 4) throw new AxisPhotoInputError(413);
  if (value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new AxisPhotoInputError();
  const input = Buffer.from(value, "base64");
  if (input.length > AXIS_PHOTO_MAX_BYTES) throw new AxisPhotoInputError(413);
  if (input.toString("base64") !== value) throw new AxisPhotoInputError();
  try {
    const image = sharp(input, { limitInputPixels: AXIS_PHOTO_MAX_PIXELS, failOn: "error" });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new AxisPhotoInputError();
    const { data, info } = await image.rotate().png().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    if (data.length > AXIS_PHOTO_MAX_BYTES) throw new AxisPhotoInputError(413);
    return { data, width: info.width, height: info.height, revision: createHash("sha256").update(data).digest("hex") };
  } catch (error) {
    if (error instanceof AxisPhotoInputError) throw error;
    throw new AxisPhotoInputError();
  }
}

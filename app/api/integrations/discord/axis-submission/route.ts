import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { readAxisPhotoBody } from "@/lib/axis-photo-upload";
import { axisSubmissionStatus, submitAxisScreenshot } from "@/lib/axis-submission-service";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  isAxisDiscordSnowflake,
  isAxisDiscordSourceAllowed,
  readAxisDiscordConfig,
  verifyAxisDiscordBearer,
} from "@/lib/axis-discord-auth";

export const runtime = "nodejs";

type DiscordSubmissionBody = {
  matchNumber: unknown;
  guildId: unknown;
  channelId: unknown;
  parentChannelId: unknown;
  messageId: unknown;
  attachmentId: unknown;
  authorId: unknown;
  photo: unknown;
};

function invalidSubmission(): never {
  throw new TypeError("Invalid Discord AXIS submission");
}

function requiredSnowflake(value: unknown): string {
  if (!isAxisDiscordSnowflake(value)) invalidSubmission();
  return value;
}

function readDiscordSubmission(value: unknown): {
  matchNumber: number;
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  messageId: string;
  attachmentId: string;
  authorId: string;
  photoData: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSubmission();
  const body = value as DiscordSubmissionBody;
  if (!Number.isSafeInteger(body.matchNumber) || Number(body.matchNumber) <= 0) invalidSubmission();
  const guildId = requiredSnowflake(body.guildId);
  const channelId = requiredSnowflake(body.channelId);
  const parentChannelId = body.parentChannelId === null ? null : requiredSnowflake(body.parentChannelId);
  const messageId = requiredSnowflake(body.messageId);
  const attachmentId = requiredSnowflake(body.attachmentId);
  const authorId = requiredSnowflake(body.authorId);
  if (!body.photo || typeof body.photo !== "object" || Array.isArray(body.photo)) invalidSubmission();
  const photo = body.photo as { data?: unknown };
  if (typeof photo.data !== "string" || !photo.data.length) invalidSubmission();
  return {
    matchNumber: Number(body.matchNumber),
    guildId,
    channelId,
    parentChannelId,
    messageId,
    attachmentId,
    authorId,
    photoData: photo.data,
  };
}

function errorName(status: number): string {
  if (status === 404) return "match_not_found";
  if (status === 413) return "photo_too_large";
  if (status === 400) return "invalid_submission";
  if (status === 409) return "submission_conflict";
  if (status === 422) return "screenshot_match_mismatch";
  return "ocr_unavailable";
}

export async function POST(request: Request) {
  const config = readAxisDiscordConfig();
  if (!config) {
    return Response.json({ error: "discord_integration_disabled" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
  if (!verifyAxisDiscordBearer(request, config)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: ADMIN_NO_STORE_HEADERS });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    const body = readDiscordSubmission(await readAxisPhotoBody(request));
    if (!isAxisDiscordSourceAllowed(config, body)) {
      return Response.json({ error: "Forbidden" }, { status: 403, headers: ADMIN_NO_STORE_HEADERS });
    }
    // The bot retries transient failures, but a Discord author must not be
    // able to keep the OCR queue busy with unbounded screenshots.
    if (!checkRateLimit(config.guildId, { bucket: "axis-discord-guild", max: 30 }).allowed
      || !checkRateLimit(`discord:${body.authorId}`, { bucket: "axis-discord-submission", max: 6 }).allowed) {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: ADMIN_NO_STORE_HEADERS });
    }
    const result = await submitAxisScreenshot({
      matchNumber: body.matchNumber,
      photoData: body.photoData,
      actor: { sub: `discord_${body.authorId}`, name: null, source: "discord" },
    });
    return Response.json({
      ok: true,
      matchNumber: result.matchNumber,
      recognizedPlayers: result.recognizedPlayers,
      totalPlayers: result.totalPlayers,
      coveragePercent: result.coveragePercent,
      confidencePercent: result.confidencePercent,
      needsReview: result.needsReview,
      missingPlayers: result.missingPlayers,
      unmatchedNames: result.unmatchedNames,
      conflictPlayers: result.conflictPlayers,
    }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const status = axisSubmissionStatus(error);
    return Response.json({ error: errorName(status) }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}

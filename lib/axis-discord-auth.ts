import { createHash, timingSafeEqual } from "node:crypto";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export interface AxisDiscordConfig {
  secret: string;
  guildId: string;
  channelIds: readonly string[];
}

/** Discord integration is opt-in: malformed or incomplete configuration stays disabled. */
export function readAxisDiscordConfig(env: NodeJS.ProcessEnv = process.env): AxisDiscordConfig | null {
  const secret = typeof env.AXIS_DISCORD_SECRET === "string" ? env.AXIS_DISCORD_SECRET : "";
  const guildId = typeof env.AXIS_DISCORD_GUILD_ID === "string" ? env.AXIS_DISCORD_GUILD_ID.trim() : "";
  const rawChannels = typeof env.AXIS_DISCORD_CHANNEL_IDS === "string" ? env.AXIS_DISCORD_CHANNEL_IDS : "";
  if (secret.length < 32 || !DISCORD_SNOWFLAKE.test(guildId)) return null;
  const channelIds = [...new Set(rawChannels.split(",").map((value) => value.trim()).filter(Boolean))];
  if (!channelIds.length || channelIds.some((value) => !DISCORD_SNOWFLAKE.test(value))) return null;
  return Object.freeze({ secret, guildId, channelIds });
}

/** Compare fixed-size digests so a secret-length difference cannot bypass timing resistance. */
export function verifyAxisDiscordBearer(request: Request, config: AxisDiscordConfig): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(config.secret).digest();
  return timingSafeEqual(supplied, expected);
}

export function isAxisDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}

export function isAxisDiscordSourceAllowed(
  config: AxisDiscordConfig,
  source: { guildId: string; channelId: string; parentChannelId: string | null },
): boolean {
  if (source.guildId !== config.guildId) return false;
  return config.channelIds.includes(source.channelId)
    || source.parentChannelId !== null && config.channelIds.includes(source.parentChannelId);
}

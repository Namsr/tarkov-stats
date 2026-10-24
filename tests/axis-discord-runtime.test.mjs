import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareDiscordRuntime } from "../scripts/prepare-discord-runtime.mjs";

async function removeDirectory(directory) {
  try { await rm(directory, { recursive: true, force: true }); }
  catch { /* cleanup must not replace the test assertion */ }
}

test("the production runtime includes a loadable Discord client and its dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-runtime-"));
  let client;
  try {
    assert.ok(await prepareDiscordRuntime(directory) > 0);
    const require = createRequire(join(directory, "entry.cjs"));
    const { Client, GatewayIntentBits } = require("discord.js");
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    assert.equal(client.isReady(), false);
  } finally {
    try { await client?.destroy(); } catch { /* cleanup must not replace the test assertion */ }
    await removeDirectory(directory);
  }
});

test("Discord hosting is opt-in and keeps its token and state outside the web service", async () => {
  const compose = await readFile("ops/docker-compose.vps.yml", "utf8");
  const bot = compose.slice(compose.indexOf("  axis-discord:"), compose.indexOf("  caddy:"));
  assert.match(bot, /profiles: \["discord"\]/);
  assert.match(bot, /<<: \*background-worker/);
  assert.match(bot, /path: \.env\.discord/);
  assert.match(bot, /axis_discord_data:\/data/);
  assert.doesNotMatch(bot, /players_data|ports:|expose:/);
});

# AXIS Discord screenshot bot

The optional worker reads attached PNG, JPEG and WebP screenshots in explicitly
allowed match channels and replies with the submission status. Players do not
need a TarkovStats account. The existing server OCR, roster matching, photo
deduplication and moderation rules remain authoritative. There are no slash
commands, role management or automatic channel creation.

## Create and install the Discord application

1. Create an application in <https://discord.com/developers/applications> under
   the account that should own the bot. Choose a name and avatar.
2. In **Bot**, enable **Message Content Intent**. Obtain a bot token when ready
   to run the worker. Keep it out of chat, source control and screenshots.
3. In **Installation**, enable **Guild Install**, add the **bot** scope and use
   the generated link to install it on the target server. Slash-command scope
   `applications.commands` is unnecessary for this worker.
4. Give the bot **View Channels**, **Read Message History** and **Send Messages**
   in the intended channels. For threads, give **Send Messages in Threads** and
   access to the intended threads. Private threads must also be accessible to
   the bot. Administrator and Manage Channels permissions are unnecessary.
5. Enable Discord Developer Mode to copy the server and channel IDs. Limit the
   bot's channel permissions as well as the application's allowlist.

Discord reference: [creating an application](https://docs.discord.com/developers/quick-start/getting-started)
and [message content access](https://docs.discord.com/developers/events/gateway#message-content-intent).

## Configure the website and worker

Generate an independent integration secret, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set these values in the **web service's existing private environment file**:

```dotenv
AXIS_DISCORD_SECRET=<generated integration secret, at least 32 characters>
AXIS_DISCORD_GUILD_ID=<server ID>
AXIS_DISCORD_CHANNEL_IDS=<allowed channel IDs, comma-separated>
```

Create a separate ignored `.env.discord` beside the active Compose file:

```dotenv
DISCORD_TOKEN=<Discord bot token>
AXIS_DISCORD_SECRET=<same integration secret as web>
AXIS_DISCORD_GUILD_ID=<same server ID as web>
AXIS_DISCORD_CHANNEL_IDS=<same allowed channel IDs as web>
AXIS_DISCORD_LANG=ru
AXIS_DISCORD_MATCH_CHANNELS={}
AXIS_DISCORD_MATCH_PREFIX=queue-
```

The confirmed AXIS naming convention is `queue-<match number>`: `queue-5771`
maps to match 5771. Only exact names with a positive integer suffix match, and
the channel allowlist still applies. For an exceptional channel, set an explicit
mapping such as `AXIS_DISCORD_MATCH_CHANNELS={"123456789012345678":1234}`.
Explicit mappings take precedence over the name prefix.

A thread is its own channel: allow its ID or its parent text channel. Channels
without a supported name or an explicit binding are ignored. The worker does
not infer matches from a player's latest game or OCR alone. Clear the prefix
if a server uses a different naming convention.

On first use the worker inspects the most recent 100 messages per configured
channel. With a saved history checkpoint it recovers subsequent messages, and
also discovers active threads under allowed text channels. Configure important
threads explicitly if they may be archived while the worker is offline.
`AXIS_DISCORD_BOOTSTRAP_MESSAGES` controls the initial window (0–100, default 100;
zero disables history recovery).
`AXIS_DISCORD_MAX_PENDING` bounds queued attachments (default 1000), and
`AXIS_DISCORD_CATCHUP_MS` sets periodic history recovery (default 60000 ms).
Live messages also enter the durable queue; history checkpoints only advance
after ordered history ingestion succeeds.

The bot token and integration secret serve different purposes. The website only
needs the integration secret, guild and allowlist, never the Discord bot token.
The submission endpoint stays disabled with incomplete configuration.

## Run locally

Use the same Node version as the project (CI uses Node 22). Install the locked
dependencies and prepare the site's OCR assets:

```sh
npm ci
node scripts/prepare-axis-ocr.mjs
```

Start the site with its normal private environment configuration. Then start the
worker separately, loading its own file:

```sh
node --env-file=.env.discord --experimental-strip-types --experimental-sqlite scripts/axis-discord-bot.mjs
```

For local use, add `AXIS_DISCORD_API_BASE_URL=http://127.0.0.1:3000` and
`AXIS_DISCORD_STATE_PATH=./data/axis-discord.db` to `.env.discord`. Outside the
local host or Compose network, use HTTPS for the website API.

## Run on the existing VPS

The normal production build includes the worker and its dependencies. The
`axis-discord` Compose service is under the opt-in `discord` profile and uses the
existing aggregate background resource budget. It has its own persistent volume
for delivery state and does not mount the site's databases. It opens no ports.
Its API target is the internal `http://web:3000` service.

Use Docker Compose 2.24 or newer (the optional environment file uses
`required: false`). After the code has been reviewed and deployed, put the
private settings beside the active Compose file, recreate web to load its
integration settings, and start the worker:

```sh
docker compose -p tarkovstats -f docker-compose.vps.yml up -d --no-build web
docker compose -p tarkovstats -f docker-compose.vps.yml --profile discord up -d --no-build axis-discord
docker compose -p tarkovstats -f docker-compose.vps.yml logs --tail 100 axis-discord
```

These commands refer to the existing deployment's active Compose file. A source
checkout keeps the tracked template at `ops/docker-compose.vps.yml`; environment
paths are relative to the active file. Do not overwrite an operator's deployed
Compose configuration without reviewing its differences.

The optional worker is not a dependency of web and is not started by the site's
normal deploy command. After later image updates, explicitly recreate
`axis-discord` using the same command. Restart it after changing channel bindings
or the token. Stop it with `docker compose -p tarkovstats -f docker-compose.vps.yml
stop axis-discord`. Keep its state volume when updating.

## Verification before real matches

Use a test channel and a known archived match. Check that a valid scoreboard
updates the same match on the site, a repeated upload does not add statistics
again, an unrelated scoreboard is rejected, and other channels are ignored.
Restart the worker during a test submission to check pending delivery recovery.
Check actual memory use alongside the existing background jobs before enabling
the worker for the full league; no new VPS capacity has been measured here.

The reply distinguishes saved player coverage from OCR confidence. Confidence
uses the site's existing conservative helper and is not a guarantee that all
numbers are correct. Conflicts remain available to the existing moderators;
the bot does not overwrite disputed statistics.

Each screenshot is reconciled with the match's already saved results. Missing
K/D/A is filled in, identical values are not counted again, and conflicting
values remain for moderator review. Replies report cumulative saved coverage
and list players still missing statistics, unmatched screenshot nicknames and
conflicting player results. A screenshot must contain a supported scoreboard
with enough reliably matched roster names to be accepted.

The match archive can lag behind the final Discord screenshot. A match-not-found
response is retried for a bounded period so that the normal archive importer has
time to publish it. A permanently invalid match binding eventually produces an
error reply. Re-upload the image after correcting that binding.

Discord's deleted-message and deleted-channel errors terminate their pending
delivery jobs. An already saved website result remains intact even when the
original Discord message disappears before acknowledgement. Temporary Discord
permission failures are retried so that restoring access can resume processing.

Live Discord delivery cannot be verified without a real application, token,
permitted test channel and confirmed channel-to-match mapping.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDiscordBotConfig } from "../lib/discord-bot/config.mjs";
import { DiscordJobStore } from "../lib/discord-bot/state.mjs";
import { DiscordBotWorker } from "../lib/discord-bot/worker.mjs";
import { downloadAttachment, validateAttachmentUrl } from "../lib/discord-bot/security.mjs";
import { resultMessage } from "../lib/discord-bot/messages.mjs";

const ENV = {
  DISCORD_TOKEN: "A".repeat(60), AXIS_DISCORD_SECRET: "S".repeat(40), AXIS_DISCORD_GUILD_ID: "100000000000000001",
  AXIS_DISCORD_CHANNEL_IDS: "200000000000000001", AXIS_DISCORD_MATCH_CHANNELS: '{"200000000000000001":42}',
};

test("Discord config fails closed when a match binding is missing", () => {
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_MATCH_CHANNELS: "" }), /MATCH_CHANNELS or .*PREFIX/);
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_API_BASE_URL: "http://public.example" }), /HTTPS/);
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_BOOTSTRAP_MESSAGES: "101" }), /0\.\.100/);
  const config = loadDiscordBotConfig(ENV);
  assert.equal(config.matchChannels.get("200000000000000001"), 42);
});

test("Discord reply names missing, unmatched and conflicting players safely", () => {
  const text = resultMessage("ru", { ok: true, needsReview: true, recognizedPlayers: 7, totalPlayers: 10, coveragePercent: 70,
    confidencePercent: null, missingPlayers: ["Missing *One*"], unmatchedNames: ["Wrong @Nick"], conflictPlayers: ["Conflict [Two]"] });
  assert.match(text, /Missing \\\*One\\\*/);
  assert.match(text, /Wrong \\\@Nick/);
  assert.match(text, /Conflict \\\[Two\\\]/);
  assert.doesNotMatch(text, /OCR 0%/);
  assert.ok(text.length <= 2000);
});

test("attachment URLs are restricted to Discord CDN and source channel", () => {
  assert.throws(() => validateAttachmentUrl("https://example.com/attachments/200000000000000001/300000000000000001/a.png?x=1", ["200000000000000001"]));
  assert.throws(() => validateAttachmentUrl("https://cdn.discordapp.com/attachments/999/300000000000000001/a.png?x=1", ["200000000000000001"]), /source/);
  const url = validateAttachmentUrl("https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/a.png?x=1", ["200000000000000001"]);
  assert.equal(url.hostname, "cdn.discordapp.com");
});

test("download bounds image body and rejects redirects", async () => {
  const attachment = { id: "300000000000000001", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/a.png?x=1" };
  const smallFetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  const result = await downloadAttachment(attachment, ["200000000000000001"], smallFetch);
  assert.equal(result.data, "AQID");
  const badFetch = async () => new Response(null, { status: 302, headers: { location: "https://example.com" } });
  await assert.rejects(() => downloadAttachment(attachment, ["200000000000000001"], badFetch), /attachment_http_302/);
});

test("state store deduplicates source attachments and recovers running jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-"));
  const path = join(directory, "state.db");
  const store = new DiscordJobStore(path);
  const job = { guildId: "100000000000000001", channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000001", attachmentId: "300000000000000001", authorId: "500000000000000001", matchNumber: 42 };
  assert.equal(store.enqueue(job).inserted, true);
  assert.equal(store.enqueue(job).inserted, false);
  const claimed = store.claimDue();
  assert.equal(claimed.status, "running");
  store.close();
  const reopened = new DiscordJobStore(path);
  assert.equal(reopened.claimDue().status, "running");
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("a full attachment batch does not advance its checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-atomic-"));
  const store = new DiscordJobStore(join(directory, "state.db"));
  const base = { guildId: "100000000000000001", channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000002", authorId: "500000000000000001", matchNumber: 42 };
  const jobs = [{ ...base, attachmentId: "300000000000000001" }, { ...base, attachmentId: "300000000000000002" }];
  assert.throws(() => store.enqueueMany(jobs, base.channelId, base.messageId, Date.now(), 1), /queue_full/);
  assert.equal(store.checkpoint(base.channelId), null);
  assert.equal(store.claimDue(), null);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("worker reads a fresh attachment URL, submits it and replies once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-worker-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const replies = [];
  const sourceMessage = {
    id: "400000000000000001", guildId: config.guildId, channelId: "200000000000000001",
    author: { id: "500000000000000001", bot: false }, webhookId: null,
    channel: null,
    attachments: new Map([["300000000000000001", { id: "300000000000000001", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/result.png?sig=1" }]]),
    reply: async (value) => replies.push(value),
  };
  const channel = { id: "200000000000000001", parentId: null, name: "match-42", messages: { fetch: async (arg) => typeof arg === "string" ? sourceMessage : new Map() } };
  sourceMessage.channel = channel;
  const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
  const apiFetch = async (url) => {
    if (String(url).includes("/api/integrations/")) return new Response(JSON.stringify({ ok: true, matchNumber: 42, recognizedPlayers: 8, totalPlayers: 10, coveragePercent: 80, confidencePercent: 91, needsReview: false }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  const store = new DiscordJobStore(config.statePath);
  const worker = new DiscordBotWorker({ config, client, store, fetchImpl: apiFetch });
  assert.equal(await worker.handleMessage(sourceMessage), 1);
  const job = store.claimDue();
  await worker.processJob(job);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /80%/);
  assert.equal(store.get(job).status, "done");
  await worker.processJob(job);
  assert.equal(replies.length, 1);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("a saved backend response is acknowledged after restart without re-downloading OCR input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-restart-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000003", attachmentId: "300000000000000003", authorId: "500000000000000001", matchNumber: 42 };
  const first = new DiscordJobStore(config.statePath);
  first.enqueue(job);
  const claimed = first.claimDue();
  first.saveResponse(claimed, { ok: true, matchNumber: 42, recognizedPlayers: 10, totalPlayers: 10, coveragePercent: 100, confidencePercent: 95, needsReview: false });
  first.close();
  const store = new DiscordJobStore(config.statePath);
  const replies = [];
  const source = { id: job.messageId, guildId: config.guildId, channelId: job.channelId, author: { id: job.authorId, bot: false }, webhookId: null, attachments: new Map(), channel: null, reply: async (value) => replies.push(value) };
  const channel = { id: job.channelId, parentId: null, name: "match-42", messages: { fetch: async (arg) => typeof arg === "string" ? source : new Map() } };
  source.channel = channel;
  const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
  const worker = new DiscordBotWorker({ config, client, store, fetchImpl: async () => { throw new Error("download must not run"); } });
  await worker.processJob(store.claimDue());
  assert.equal(replies.length, 1);
  assert.equal(store.get({ guild_id: job.guildId, channel_id: job.channelId, message_id: job.messageId, attachment_id: job.attachmentId }).status, "done");
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("startup catch-up includes active threads under an allowed parent channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-threads-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"), AXIS_DISCORD_MATCH_CHANNELS: '{"200000000000000001":42}' });
  const thread = { id: "200000000000000002", parentId: "200000000000000001", name: "match-thread", messages: { fetch: async () => new Map([["400000000000000004", { id: "400000000000000004", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000002", author: { id: "500000000000000001", bot: false }, webhookId: null, channel: thread, attachments: new Map() }]]) } };
  const parent = { id: "200000000000000001", parentId: null, name: "matches", messages: { fetch: async () => new Map() }, threads: { fetchActive: async () => ({ threads: new Map([[thread.id, thread]]) }) } };
  const client = { channels: { fetch: async (id) => id === parent.id ? parent : thread }, user: { id: "900000000000000001" } };
  const store = new DiscordJobStore(config.statePath);
  const worker = new DiscordBotWorker({ config, client, store });
  await worker.catchUpConfiguredChannels();
  assert.equal(store.checkpoint(thread.id), "400000000000000004");
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("a later live message cannot advance past an image rejected by a full queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-gap-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"), AXIS_DISCORD_MAX_PENDING: "1" });
  const attachment = { id: "300000000000000005", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000005/result.png?sig=1" };
  const image = { id: "400000000000000005", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, attachments: new Map([[attachment.id, attachment]]), channel: null };
  const plain = { id: "400000000000000006", createdTimestamp: 2, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, attachments: new Map(), channel: null };
  const channel = { id: "200000000000000001", parentId: null, name: "match-42", messages: { fetch: async () => new Map([[image.id, image], [plain.id, plain]]) } };
  image.channel = channel; plain.channel = channel;
  const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
  const store = new DiscordJobStore(config.statePath);
  const filler = { guildId: config.guildId, channelId: channel.id, parentChannelId: null, messageId: "400000000000000007", attachmentId: "300000000000000007", authorId: "500000000000000001", matchNumber: 42 };
  store.enqueue(filler);
  const worker = new DiscordBotWorker({ config, client, store });
  await assert.rejects(() => worker.handleMessage(image), /queue_full/);
  await worker.handleMessage(plain);
  assert.equal(store.checkpoint(channel.id), null);
  const claimed = store.claimDue();
  store.markAcked(claimed);
  await worker.catchUpChannel(channel);
  assert.equal(store.checkpoint(channel.id), plain.id);
  assert.equal(store.get({ guild_id: config.guildId, channel_id: channel.id, message_id: image.id, attachment_id: attachment.id }).status, "pending");
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("distinct multi-image replies are not suppressed by history entries without nonces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-nonce-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const history = [];
  const replies = [];
  const sourceMessage = {
    id: "400000000000000010", guildId: config.guildId, channelId: "200000000000000001",
    author: { id: "500000000000000001", bot: false }, webhookId: null, channel: null,
    attachments: new Map([
      ["300000000000000010", { id: "300000000000000010", name: "one.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000010/one.png?sig=1" }],
      ["300000000000000011", { id: "300000000000000011", name: "two.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000011/two.png?sig=1" }],
    ]),
    reply: async (value) => {
      replies.push(value);
      // Discord history may omit the nonce even though the original reply had
      // one. Keep the content so the worker can distinguish these replies.
      history.push({ author: { id: "900000000000000001" }, reference: { messageId: sourceMessage.id }, content: value.content, nonce: null });
    },
  };
  const channel = {
    id: sourceMessage.channelId, parentId: null, name: "match-42", messages: {
      fetch: async (arg) => typeof arg === "string" ? sourceMessage : new Map(history.map((item, index) => [String(index), item])),
    },
  };
  sourceMessage.channel = channel;
  let submissions = 0;
  const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
  const apiFetch = async (url) => {
    if (String(url).includes("/api/integrations/")) {
      submissions += 1;
      const complete = submissions === 2;
      return new Response(JSON.stringify({ ok: true, matchNumber: 42, recognizedPlayers: complete ? 10 : 8, totalPlayers: 10,
        coveragePercent: complete ? 100 : 80, confidencePercent: 91, needsReview: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  const store = new DiscordJobStore(config.statePath);
  const worker = new DiscordBotWorker({ config, client, store, fetchImpl: apiFetch });
  assert.equal(await worker.handleMessage(sourceMessage), 2);
  for (let job = store.claimDue(); job; job = store.claimDue()) await worker.processJob(job);
  assert.equal(replies.length, 2);
  assert.match(replies[0].content, /80%/);
  assert.match(replies[1].content, /100%/);
  assert.equal(await worker.findExistingAck(channel, sourceMessage.id, "nonce-not-present", replies[0].content), true);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("a revoked source fails a queued job without fetching Discord or submitting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-revoked-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000012", attachmentId: "300000000000000012", authorId: "500000000000000001", matchNumber: 42 };
  const store = new DiscordJobStore(config.statePath);
  store.enqueue(job);
  const claimed = store.claimDue();
  config.channelIdSet.clear();
  let channelFetches = 0;
  let apiCalls = 0;
  const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => { channelFetches += 1; throw new Error("must not fetch"); } } };
  const worker = new DiscordBotWorker({ config, client, store, fetchImpl: async () => { apiCalls += 1; throw new Error("must not submit"); } });
  await worker.processJob(claimed);
  const failed = store.get(claimed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.last_error, "source_revoked");
  assert.equal(channelFetches, 0);
  assert.equal(apiCalls, 0);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("a fresh message whose match binding changed is failed without acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-stale-binding-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"), AXIS_DISCORD_MATCH_CHANNELS: "", AXIS_DISCORD_MATCH_PREFIX: "match-" });
  const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000013", attachmentId: "300000000000000013", authorId: "500000000000000001", matchNumber: 42 };
  const replies = [];
  const source = { id: job.messageId, guildId: config.guildId, channelId: job.channelId, author: { id: job.authorId, bot: false }, webhookId: null, attachments: new Map([[job.attachmentId, { id: job.attachmentId, name: "result.png", contentType: "image/png", url: `https://cdn.discordapp.com/attachments/${job.channelId}/${job.attachmentId}/result.png?sig=1` }]]), channel: null,
    reply: async (value) => replies.push(value) };
  const channel = { id: job.channelId, parentId: null, name: "match-43", messages: { fetch: async (arg) => typeof arg === "string" ? source : new Map() } };
  source.channel = channel;
  let apiCalls = 0;
  const store = new DiscordJobStore(config.statePath);
  store.enqueue(job);
  const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
  const worker = new DiscordBotWorker({ config, client, store, fetchImpl: async () => { apiCalls += 1; throw new Error("must not submit"); } });
  const claimed = store.claimDue();
  await worker.processJob(claimed);
  assert.equal(store.get(claimed).status, "failed");
  assert.equal(store.get(claimed).last_error, "source_revoked");
  assert.equal(replies.length, 0);
  assert.equal(apiCalls, 0);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("catch-up processes same-timestamp messages by snowflake ID order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-order-"));
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const low = { id: "400000000000000014", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, channel: null, attachments: new Map() };
  const high = { id: "400000000000000015", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, channel: null, attachments: new Map() };
  const channel = { id: "200000000000000001", parentId: null, name: "match-42", messages: { fetch: async () => new Map([[high.id, high], [low.id, low]]) } };
  low.channel = channel; high.channel = channel;
  const store = new DiscordJobStore(config.statePath);
  const worker = new DiscordBotWorker({ config, client: { user: { id: "900000000000000001" } }, store });
  const seen = [];
  worker.handleMessage = async (message) => { seen.push(message.id); };
  await worker.catchUpChannel(channel);
  assert.deepEqual(seen, [low.id, high.id]);
  assert.equal(store.checkpoint(channel.id), high.id);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

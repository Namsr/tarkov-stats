#!/usr/bin/env node
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createStringObjectParser, argValue, hasArg } from "./seasonal-profile-sync-core.mjs";
import { fetchTarkovJson, lastSkillAccessSeconds } from "../lib/tarkov-api.ts";
import { BAN_PROFILE_PATHS, validateWave, parseBanProfile, initializeBanImportDb,
  importBanCandidate, candidateEvidenceHash } from "../lib/ban-import.ts";

const MAX_BYTES = 8 * 1024 * 1024;

export async function boundedText(response, maxBytes = MAX_BYTES) {
  if (!response.body) throw new Error("response body missing");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new Error("response too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

export function createRateLimitedRequest(rps, request = fetchTarkovJson, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  if (!Number.isFinite(rps) || rps <= 0 || rps > 5) throw new Error("rps must be >0 and <=5");
  let nextStart = 0;
  return async url => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(Math.max(0, nextStart - Date.now()));
      nextStart = Date.now() + 1000 / rps;
      let response;
      try { response = await request(url, { signal: AbortSignal.timeout(10000), cache: "no-store" }); }
      catch (error) { if (attempt === 2) throw error; await sleep(1000 * 2 ** attempt); continue; }
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry === null ? NaN : Number(retry);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 1000 * 2 ** attempt;
        await response.body?.cancel();
        if (attempt === 2) throw new Error(`upstream ${response.status}: ${url}`);
        await sleep(Math.min(300000, Math.max(1000, Number.isFinite(wait) ? wait : 1000)));
        continue;
      }
      return response;
    }
    throw new Error("request retries exhausted");
  };
}

export function parseNicknameCsv(text) {
  // Nickname cells contain no commas/newlines. Quoted nickname cells are valid;
  // unsupported cells remain counted in the report rather than becoming names.
  if (/^\s*</.test(text)) throw new Error("CSV response returned HTML");
  const cells = text.replace(/^\uFEFF/, "").split(/[,\r\n]+/).map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const nicknames = [...new Set(cells.filter(s => /^[a-zA-Z0-9_-]{1,15}$/.test(s)))];
  if (!nicknames.length) throw new Error("CSV has no valid nicknames");
  return { nicknames, ignoredCells: cells.length - cells.filter(s => /^[a-zA-Z0-9_-]{1,15}$/.test(s)).length };
}

export async function loadWaves(manifest, request) {
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("manifest must contain ban waves");
  const waves = [];
  for (const input of manifest) {
    if (!input || typeof input !== "object") throw new Error("invalid wave manifest");
    let nicknames = input.nicknames;
    if (!nicknames) {
      const url = new URL(input.csvUrl);
      if (url.protocol !== "https:" || url.username || url.password || !["docs.google.com", "tarkovbot.eu"].includes(url.hostname)) throw new Error("unsupported CSV source");
      const response = await request(url.toString());
      if (!response.ok) throw new Error(`ban list ${response.status}`);
      const parsed = parseNicknameCsv(await boundedText(response)); nicknames = parsed.nicknames;
      console.log(JSON.stringify({ wave: input.date, nicknames: nicknames.length, ignoredCells: parsed.ignoredCells }));
    }
    waves.push(validateWave({ date: input.date, source: input.source, nicknames }));
  }
  return waves;
}

export async function discoverBanCandidates(waves, request) {
  const byName = new Map();
  for (const wave of waves) for (const name of wave.nicknames) {
    const key = name.toLowerCase(); const entries = byName.get(key) ?? [];
    if (!entries.some(w => w.date === wave.date && w.source === wave.source)) entries.push(wave);
    byName.set(key, entries);
  }
  const response = await request("https://players.tarkov.dev/profile/index.json");
  if (!response.ok || !response.body) throw new Error(`player index ${response.status}`);
  const candidates = []; const decoder = new TextDecoder();
  const parser = createStringObjectParser((aidText, nickname) => {
    const aid = Number(aidText);
    if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error("invalid index account id");
    const entries = byName.get(nickname.toLowerCase());
    // Retain only this nickname as evidence; do not repeat entire wave lists per ID.
    if (entries) candidates.push({ aid, nickname, waves: entries.map(w => ({ ...w, nicknames: [nickname] })) });
  });
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength; if (bytes > 128 * 1024 * 1024) throw new Error("index too large");
    parser.append(decoder.decode(chunk, { stream: true }));
  }
  parser.finish(decoder.decode());
  return candidates.sort((a, b) => a.aid - b.aid);
}

export async function collectBanProfiles(candidate, request, seasonalCycle) {
  const profiles = [];
  for (const [mode, path] of Object.entries(BAN_PROFILE_PATHS)) {
    const response = await request(`https://players.tarkov.dev/${path}/${candidate.aid}.json`);
    if (response.status === 404) { if (mode === "regular") break; continue; }
    if (!response.ok) throw new Error(`${mode} profile ${response.status}`);
    const input = { mode, raw: await boundedText(response), ...(mode === "seasonal" ? { cycleId: seasonalCycle } : {}) };
    const profile = parseBanProfile(input, candidate.aid);
    profiles.push(input);
    if (mode === "regular" && lastSkillAccessSeconds(profile) === null) break;
  }
  return profiles;
}

export function publishBanArchive(stage, targetPath, playersPath, progressionPath) {
  const stagePath = String(stage.prepare("PRAGMA database_list").get().file);
  if (new Set([targetPath, playersPath, progressionPath, ...(stagePath ? [stagePath] : [])].map(p => resolve(p))).size !== (stagePath ? 4 : 3)) throw new Error("database paths must be distinct");
  const target = new DatabaseSync(targetPath);
  try {
    initializeBanImportDb(target);
    target.exec("PRAGMA busy_timeout=5000");
    target.prepare("ATTACH DATABASE ? AS players_db").run(playersPath);
    target.prepare("ATTACH DATABASE ? AS progression_db").run(progressionPath);
    let applied = 0;
    for (const account of stage.prepare(`SELECT DISTINCT e.aid FROM banned_wave_evidence e
      WHERE (SELECT r.decision FROM ban_import_results r WHERE r.aid=e.aid ORDER BY r.checked_at DESC,r.rowid DESC LIMIT 1)='accepted'
      ORDER BY e.aid`).all()) {
      const evidence = stage.prepare("SELECT listed_date,nickname,source FROM banned_wave_evidence WHERE aid=?").all(account.aid);
      const profiles = stage.prepare(`SELECT mode,cycle_id,raw_json_gzip,raw_sha256 FROM banned_mode_snapshots s WHERE aid=?
        AND profile_updated_at=(SELECT MAX(t.profile_updated_at) FROM banned_mode_snapshots t
          WHERE t.aid=s.aid AND t.mode=s.mode AND t.cycle_id=s.cycle_id)`).all(account.aid)
        .map(r => {
          const raw = gunzipSync(r.raw_json_gzip, { maxOutputLength: MAX_BYTES }).toString("utf8");
          if (createHash("sha256").update(raw).digest("hex") !== r.raw_sha256) throw new Error("stage profile checksum mismatch");
          return { mode: r.mode, cycleId: r.cycle_id, raw };
        });
      const candidate = { aid: account.aid, nickname: evidence[0].nickname,
        waves: evidence.map(e => ({ date: e.listed_date, source: e.source, nicknames: [e.nickname] })) };
      if (importBanCandidate(target, candidate, profiles) !== "accepted") throw new Error(`stage eligibility changed: ${account.aid}`);
      applied++;
    }
    return applied;
  } finally { target.close(); }
}

async function main() {
  if (hasArg(process.argv, "--help")) {
    console.log("Usage: node scripts/import-ban-list.mjs --manifest waves.json --db stage.db --seasonal-cycle cycle-id [--rps 2] [--limit 1000] [--retry]\nPublish a reviewed stage: add --publish-to bans.db --players-db players.db --progression-db progression.db. Run under the shared writer locks; take a verified backup first.");
    return;
  }
  const dbPath = argValue(process.argv, "--db", ""); const manifestPath = argValue(process.argv, "--manifest", "");
  const seasonalCycle = argValue(process.argv, "--seasonal-cycle", "");
  if (!dbPath || !manifestPath || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(seasonalCycle)) throw new Error("explicit --db, --manifest and --seasonal-cycle required");
  const limit = Number(argValue(process.argv, "--limit", "0"));
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid limit");
  const publishPath = argValue(process.argv, "--publish-to", "");
  const playersPath = argValue(process.argv, "--players-db", ""); const progressionPath = argValue(process.argv, "--progression-db", "");
  if (publishPath && (!playersPath || !progressionPath || new Set([dbPath, publishPath, playersPath, progressionPath].map(p => resolve(p))).size !== 4)) throw new Error("publishing requires four distinct explicit database paths");
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(resolve(dbPath));
  try {
    initializeBanImportDb(db);
    const request = createRateLimitedRequest(Number(argValue(process.argv, "--rps", "2")));
    const waves = await loadWaves(JSON.parse(readFileSync(manifestPath, "utf8")), request);
    const candidates = await discoverBanCandidates(waves, request);
    const totals = { waves: waves.length, matched: candidates.length, checked: 0, resumed: 0, errors: 0, decisions: {} };
    for (const candidate of limit ? candidates.slice(0, limit) : candidates) {
      if (!hasArg(process.argv, "--retry") && db.prepare("SELECT 1 FROM ban_import_results WHERE aid=? AND evidence_hash=?").get(candidate.aid, candidateEvidenceHash(candidate))) { totals.resumed++; continue; }
      try {
        const profiles = await collectBanProfiles(candidate, request, seasonalCycle);
        const decision = importBanCandidate(db, candidate, profiles);
        totals.decisions[decision] = (totals.decisions[decision] ?? 0) + 1;
      } catch (error) { totals.errors++; console.error(JSON.stringify({ aid: candidate.aid, error: error.message })); }
      totals.checked++;
      if (totals.checked % 25 === 0) console.log(JSON.stringify(totals));
    }
    if (publishPath) {
      if (totals.errors) throw new Error("profile errors remain; refusing automatic publication");
      totals.published = publishBanArchive(db, resolve(publishPath), resolve(playersPath), resolve(progressionPath));
    }
    console.log(JSON.stringify(totals));
    if (totals.errors) process.exitCode = 1;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

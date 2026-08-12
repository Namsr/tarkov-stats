#!/usr/bin/env node

import { spawn } from "node:child_process";

const INTERVAL_MS = envInteger("SEASONAL_FEED_INTERVAL_MS", 15 * 60_000, 60_000);
const START_DELAY_MS = envInteger("SEASONAL_FEED_START_DELAY_MS", 15_000, 0);
const scripts = ["scripts/sync-seasonal-index.mjs", "scripts/sync-seasonal-profiles.mjs"];

let activeChild = null;
let running = false;
let stopping = false;

const interval = setInterval(() => void runOnce(), INTERVAL_MS);
const startup = setTimeout(() => void runOnce(), START_DELAY_MS);

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

async function runOnce() {
  if (running || stopping) return;
  running = true;
  try {
    for (const script of scripts) {
      try {
        await runScript(script);
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} Seasonal collector ${script} failed: ${message(error)}\n`);
      }
    }
  } finally {
    running = false;
  }
}

function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", script], {
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = null;
      if (stopping) resolve();
      else if (code === 0) resolve();
      else reject(new Error(signal ? `terminated by ${signal}` : `exit code ${code ?? "unknown"}`));
    });
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearTimeout(startup);
  activeChild?.kill(signal);
}

function envInteger(name, fallback, minimum) {
  const raw = process.env[name];
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

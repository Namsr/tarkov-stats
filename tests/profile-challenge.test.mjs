import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createProfileChallenge } from '../ops/profile-challenge.mjs';

const ONLINE = 'tarkovstats.online';
const RU = 'tarkovstats.ru';
const SIGNING_KEY = Buffer.alloc(32, 7);

async function start({ hostname = ONLINE, verify, ...overrides } = {}) {
  let now = 0;
  const server = createProfileChallenge({
    siteKey: '1x00000000000000000000AA',
    signingKey: SIGNING_KEY,
    verify: verify ?? (async (token) => ({ success: token === 'good', hostname, action: 'profile_check' })),
    clock: () => now,
    ipRatePerSecond: 1,
    ipBurst: 2,
    globalLimit: 100,
    holdMs: 1000,
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    advance(ms) { now += ms; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function request(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function admission(port, { host = ONLINE, ip = '203.0.113.7', uri = '/player/regular/1', headers = {} } = {}) {
  return request(port, 'GET', '/internal/profile-admission', {
    host, 'x-profile-client-ip': ip, 'x-forwarded-uri': uri, ...headers,
  });
}

test('per-client token bucket answers 429 and refills', async (t) => {
  const service = await start({ ipRatePerSecond: 1, ipBurst: 2 });
  t.after(() => service.close());
  const ip = '198.51.100.10';
  assert.equal((await admission(service.port, { ip })).status, 204);
  assert.equal((await admission(service.port, { ip, uri: '/api/player/profile' })).status, 204);
  const limited = await admission(service.port, { ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '10');
  assert.equal((await admission(service.port, { ip: '198.51.100.11' })).status, 204, 'another client keeps its own budget');
  service.advance(1000);
  assert.equal((await admission(service.port, { ip })).status, 204);
});

test('a global page burst challenges .online but leaves API and .ru alone', async (t) => {
  const service = await start({ ipBurst: 100, ipRatePerSecond: 100, globalLimit: 2, globalWindowMs: 100, holdMs: 1000 });
  t.after(() => service.close());
  assert.equal((await admission(service.port, { ip: '198.51.100.20' })).status, 204);
  const challenged = await admission(service.port, { ip: '198.51.100.21' });
  assert.equal(challenged.status, 302);
  assert.equal(challenged.headers.location, '/__profile-check?return=%2Fplayer%2Fregular%2F1');
  assert.equal((await admission(service.port, { ip: '198.51.100.22' })).status, 302, 'new clients see the challenge while held');
  assert.equal((await admission(service.port, { ip: '198.51.100.23', uri: '/api/player/profile' })).status, 204,
    'API calls are rate limited, never challenged');
  assert.equal((await admission(service.port, { ip: '198.51.100.24', headers: { rsc: '1', 'next-router-prefetch': '1' } })).status, 429,
    'prefetch gets 429 instead of an HTML challenge');
  assert.equal((await admission(service.port, { ip: '198.51.100.25', host: RU })).status, 204,
    '.ru gets the token bucket but is not challenged');
  service.advance(1001);
  assert.equal((await admission(service.port, { ip: '198.51.100.26' })).status, 204, 'the hold expires');
});

test('the challenge issues a host-bound pass that bypasses a later hold', async (t) => {
  const seen = [];
  const service = await start({
    ipBurst: 100,
    ipRatePerSecond: 100,
    globalLimit: 2,
    globalWindowMs: 100,
    holdMs: 1000,
    verify: async (token) => {
      seen.push(token);
      return { success: true, hostname: ONLINE, action: 'profile_check' };
    },
  });
  t.after(() => service.close());
  const ip = '198.51.100.30';
  const page = await request(service.port, 'GET', '/__profile-check?return=%2Fplayer%2Fregular%2F42', { host: ONLINE, 'x-profile-client-ip': ip });
  assert.equal(page.status, 200);
  assert.match(page.body, /challenges\.cloudflare\.com/);
  assert.match(page.headers['content-security-policy'], /frame-src https:\/\/challenges\.cloudflare\.com/);
  const created = await request(service.port, 'POST', '/__profile-check', {
    host: ONLINE,
    'x-profile-client-ip': ip,
    origin: `https://${ONLINE}`,
    'content-type': 'application/x-www-form-urlencoded',
  }, 'return=%2Fplayer%2Fregular%2F42&token=good');
  assert.equal(created.status, 303);
  assert.equal(created.headers.location, '/player/regular/42');
  assert.deepEqual(seen, ['good']);
  const cookie = created.headers['set-cookie'][0].split(';')[0];
  assert.match(cookie, /^__Host-profile_pass=\d{10}\.[\w-]{43}$/);
  assert.equal((await admission(service.port, { ip: '198.51.100.31' })).status, 204);
  assert.equal((await admission(service.port, { ip: '198.51.100.32' })).status, 302, 'the second page triggers the hold');
  assert.equal((await admission(service.port, { ip, headers: { cookie } })).status, 204, 'solved clients keep browsing during a hold');
  assert.equal((await admission(service.port, { ip: '198.51.100.33', uri: '/api/player/profile', headers: { cookie } })).status, 204);
  assert.deepEqual(seen, ['good'], 'a valid pass is not re-verified');
});

test('unknown hosts, invalid client addresses and non-profile targets are refused', async (t) => {
  const service = await start();
  t.after(() => service.close());
  assert.equal((await admission(service.port, { host: 'example.com' })).status, 404);
  assert.equal((await admission(service.port, { ip: 'not-an-ip' })).status, 404);
  assert.equal((await admission(service.port, { ip: '198.51.100.40', uri: '/leaderboard' })).status, 400);
});

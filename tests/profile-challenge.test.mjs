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
  assert.equal((await admission(service.port, { ip: '198.51.100.27', headers: { rsc: '1' } })).status, 429,
    'client navigation (RSC without prefetch) gets 429, not an HTML body');
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

test('token verification is rate limited per client', async (t) => {
  const service = await start({ verifyRatePerSecond: 0, verifyBurst: 2, ipBurst: 100, ipRatePerSecond: 100 });
  t.after(() => service.close());
  const post = (ip) => request(service.port, 'POST', '/__profile-check', {
    host: ONLINE,
    'x-profile-client-ip': ip,
    origin: `https://${ONLINE}`,
    'content-type': 'application/x-www-form-urlencoded',
  }, 'return=%2Fplayer%2Fregular%2F42&token=bad');
  const attempts = await Promise.all([post('198.51.100.50'), post('198.51.100.50'), post('198.51.100.50'), post('198.51.100.50')]);
  assert.equal(attempts.filter((entry) => entry.status === 403).length, 2, 'the first attempts reach siteverify');
  const limited = attempts.filter((entry) => entry.status === 429);
  assert.equal(limited.length, 2, 'junk tokens exhaust the verification bucket');
  assert.equal(limited[0].headers['retry-after'], '10');
  assert.equal((await post('198.51.100.51')).status, 403, 'another client keeps its own verification budget');
});

test('only a forward-confirmed Googlebot skips the hold', async (t) => {
  const verified = '66.249.66.1';
  const service = await start({
    ipBurst: 100,
    ipRatePerSecond: 100,
    globalLimit: 2,
    globalWindowMs: 100,
    holdMs: 1000,
    verifyBot: async (ip, userAgent) => ip === verified && /googlebot/i.test(userAgent ?? ''),
  });
  t.after(() => service.close());
  const googlebot = { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' };
  assert.equal((await admission(service.port, { ip: '198.51.100.60' })).status, 204);
  assert.equal((await admission(service.port, { ip: '198.51.100.61' })).status, 302, 'the hold is active');
  assert.equal((await admission(service.port, { ip: verified, headers: googlebot })).status, 204,
    'a verified crawler is not sent to Turnstile');
  assert.equal((await admission(service.port, { ip: '198.51.100.62', headers: googlebot })).status, 302,
    'a spoofed Googlebot User-Agent still gets the challenge');
  assert.equal((await admission(service.port, { ip: verified })).status, 302,
    'the bypass is tied to the crawler User-Agent');
});

test('a distributed API burst is capped globally', async (t) => {
  const service = await start({ ipBurst: 100, ipRatePerSecond: 100, apiLimit: 2, apiWindowMs: 100, holdMs: 1000 });
  t.after(() => service.close());
  assert.equal((await admission(service.port, { ip: '198.51.100.70', uri: '/api/player/profile' })).status, 204);
  assert.equal((await admission(service.port, { ip: '198.51.100.71', uri: '/api/player/profile' })).status, 204);
  const limited = await admission(service.port, { ip: '198.51.100.72', uri: '/api/player/profile' });
  assert.equal(limited.status, 429, 'the API ceiling is not per client');
  assert.equal(limited.headers['retry-after'], '10');
  assert.equal((await admission(service.port, { ip: '198.51.100.73' })).status, 204, 'pages are unaffected by the API hold');
  service.advance(1001);
  assert.equal((await admission(service.port, { ip: '198.51.100.74', uri: '/api/player/profile' })).status, 204);
});

test('online API bursts reserve capacity for a valid pass and restrict anonymous reads', async (t) => {
  const service = await start({ apiLimit: 4, apiWindowMs: 100, holdMs: 1000 });
  t.after(() => service.close());
  const ip = '198.51.100.80';
  const created = await request(service.port, 'POST', '/__profile-check', {
    host: ONLINE,
    'x-profile-client-ip': ip,
    origin: `https://${ONLINE}`,
    'content-type': 'application/x-www-form-urlencoded',
  }, 'return=%2Fplayer%2Fregular%2F42&token=good');
  assert.equal(created.status, 303);
  const cookie = created.headers['set-cookie'][0].split(';')[0];
  const version = { 'x-profile-admission-version': '1' };
  const call = (clientIp, extraHeaders = {}, host = ONLINE) => admission(service.port, {
    host, ip: clientIp, uri: '/api/player/profile?aid=42', headers: { ...version, ...extraHeaders },
  });

  assert.equal((await call(ip)).headers['x-profile-access'], 'anonymous');
  assert.equal((await call(ip)).headers['x-profile-access'], 'snapshot-only');
  const limited = await call('198.51.100.81', { cookie });
  assert.equal(limited.status, 429, 'a pass copied to a different IP cannot use the reserved budget');
  assert.deepEqual(JSON.parse(limited.body), { error: 'Rate limit exceeded' });
  assert.equal(limited.headers['retry-after'], '10');
  assert.equal((await call(ip, { cookie }, 'www.tarkovstats.online')).status, 429,
    'a pass copied to another hostname cannot use the reserved budget');
  assert.equal((await call(ip, { cookie: cookie + 'x' })).status, 429);
  assert.equal((await call(ip, { cookie })).status, 204, 'anonymous exhaustion on the same IP leaves the verified budget');
  assert.equal((await call(ip, { cookie })).headers['x-profile-access'], undefined, 'verified reads can refresh');
  assert.equal((await call(ip, { cookie })).status, 429, 'verified requests are also bounded');

  const page = await admission(service.port, { ip: '198.51.100.82', headers: version });
  assert.equal(page.status, 302, 'API-only traffic also activates the browser verification flow');
  assert.equal((await call('198.51.100.83', {}, RU)).headers['x-profile-access'], undefined);
  assert.equal((await admission(service.port, { uri: '/api/player/profile' })).status, 204,
    'a gateway that does not copy policy headers keeps the legacy contract');
  service.advance(101);
  assert.equal((await call('198.51.100.84')).headers['x-profile-access'], 'snapshot-only');
  service.advance(1000);
  assert.equal((await call('198.51.100.85')).headers['x-profile-access'], 'anonymous');
});

test('unknown hosts, invalid client addresses and non-profile targets are refused', async (t) => {
  const service = await start();
  t.after(() => service.close());
  assert.equal((await request(service.port, 'GET', '/__health')).status, 200);
  assert.equal((await admission(service.port, { host: 'example.com' })).status, 404);
  assert.equal((await admission(service.port, { ip: 'not-an-ip' })).status, 404);
  assert.equal((await admission(service.port, { ip: '198.51.100.40', uri: '/leaderboard' })).status, 400);
});

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Run against the production Caddy version, without Docker or the live VPS:
// CADDY_BIN=/path/to/caddy npm run test:ops
const caddy = process.env.CADDY_BIN;

test('Caddy rejects excess HTTP/2 requests across sites and releases timed-out slots', {
  skip: !caddy && 'Set CADDY_BIN to run the Caddy integration check',
  timeout: 60_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'caddy-overload-'));
  let child;
  let client;
  let closed;
  const held = new Set();
  let active = 0;
  let peak = 0;
  let received = 0;
  const upstream = http.createServer((req, res) => {
    received++;
    active++;
    peak = Math.max(peak, active);
    res.once('close', () => { active--; held.delete(res); });
    if (req.url === '/reset') req.socket.destroy();
    else if (req.url === '/hold' || req.url === '/stall') held.add(res);
    else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ip: req.headers['x-real-ip'], requestId: req.headers['x-request-id'] }));
    }
  });
  t.after(async () => {
    client?.destroy();
    if (child) {
      child.kill();
      await closed;
    }
    const stopped = new Promise((resolve) => upstream.close(resolve));
    upstream.closeAllConnections();
    await stopped;
    await rm(dir, { recursive: true, force: true });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));

  // Adapt the actual production source first; only network addresses and the
  // certificate issuer change for the local test. Keep all proxy limits intact.
  const source = await readFile('ops/Caddyfile', 'utf8');
  execFileSync(caddy, ['adapt', '--config', 'ops/Caddyfile', '--adapter', 'caddyfile'], {
    stdio: 'pipe', timeout: 10_000, windowsHide: true,
  });
  const config = source.replace('{', `{
    admin off
    persist_config off
    local_certs
    skip_install_trust
    auto_https disable_redirects
    default_bind 127.0.0.1`)
    .replace('servers {', 'servers {\n        protocols h1 h2')
    .replace('web:3000', `127.0.0.1:${upstream.address().port}`)
    .replace(/^tarkovstats\.ru, www\.tarkovstats\.ru \{/m,
      `https://tarkovstats.ru:${port}, https://www.tarkovstats.ru:${port} {`)
    .replace(/^tarkovstats\.online, www\.tarkovstats\.online \{/m,
      `https://tarkovstats.online:${port}, https://www.tarkovstats.online:${port} {`);
  const file = join(dir, 'Caddyfile');
  await writeFile(file, config);
  child = spawn(caddy, ['run', '--config', file, '--adapter', 'caddyfile'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, GOMEMLIMIT: '192MiB', APPDATA: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
  });
  let logs = '';
  const profileLogs = [];
  let partial = '';
  child.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-12_000);
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.event === 'profile_access_v1') profileLogs.push(entry);
      } catch { /* Caddy may emit an unstructured startup diagnostic. */ }
    }
  });
  closed = once(child, 'close');
  const deadline = Date.now() + 10_000;
  while (true) {
    assert.equal(child.exitCode, null, logs);
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) break;
    assert.ok(Date.now() < deadline, logs);
    await delay(50);
  }
  // The listener opens before the local TLS certificates finish provisioning.
  while (true) {
    client = http2.connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false, servername: 'tarkovstats.ru',
    });
    try { await once(client, 'connect'); break; }
    catch {
      client.destroy();
      assert.ok(Date.now() < deadline, logs);
      await delay(100);
    }
  }
  function request(path = '/', host = 'tarkovstats.ru', method = 'GET') {
    return new Promise((resolve, reject) => {
      const stream = client.request({ ':path': path, ':authority': `${host}:${port}`, ':method': method,
        authorization: 'Bearer private-test-token', cookie: 'session=private-test-cookie',
        'x-request-id': 'forged-private-request-id',
        'x-real-ip': '203.0.113.7', 'cf-connecting-ip': '203.0.113.8' });
      let headers;
      let body = '';
      stream.on('response', (value) => { headers = value; });
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { body += chunk; });
      stream.on('error', (error) => reject(new Error(`${host}${path}: ${logs.slice(-3000)}`, { cause: error })));
      stream.on('end', () => resolve({ status: headers?.[':status'], headers, body }));
      stream.end();
    });
  }
  const normal = await request();
  assert.equal(normal.status, 200);
  assert.equal(JSON.parse(normal.body).ip, '127.0.0.1', 'untrusted IP headers must stay ignored');
  assert.equal(normal.headers.server, undefined);
  assert.match(normal.headers['strict-transport-security'], /max-age=31536000/);
  t.diagnostic('ordinary request and client IP handling passed');
  const beforeEmpty = received;
  const emptyPaths = ['/api/player/profile', '/api/player/profile?aid=',
    '/api/player/profile?mode=pve', '/api/player/profile?%61id=',
    '/api/player/profile?aid=&aid=123', '/api/player/profile?aid'];
  for (const host of ['tarkovstats.ru', 'tarkovstats.online']) {
    for (const path of emptyPaths) {
      const response = await request(path, host);
      assert.equal(response.status, 400, `${host}${path}`);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['content-type'], 'application/json');
      assert.match(JSON.parse(response.body).error, /Invalid account ID/);
    }
  }
  assert.equal(received, beforeEmpty, 'empty IDs must never reach Next or consume its rate limit');
  const passedPaths = ['/api/player/profile?aid=123&aid=',
    '/api/player/profile?%61id=%31%32%33',
    '/api/player/profile?aid=123&mode=pve&secret=private-query',
    '/api/player/profile?aid=https%3A%2F%2Ftarkov.dev%2Fplayers%2Fregular%2F456%3Ftoken%3Dprivate-query',
    '/api/player/profile?aid=not-an-id-private-query'];
  const forwardedIds = [];
  for (const path of passedPaths) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    forwardedIds.push(JSON.parse(response.body).requestId);
  }
  const logDeadline = Date.now() + 3000;
  while (profileLogs.length < emptyPaths.length * 2 + passedPaths.length && Date.now() < logDeadline) await delay(10);
  assert.equal(profileLogs.length, emptyPaths.length * 2 + passedPaths.length, 'profile access logging must not sample');
  const identityLogs = profileLogs.slice(-passedPaths.length);
  assert.deepEqual(identityLogs.map((entry) => entry.request_id), forwardedIds);
  assert.ok(new Set(profileLogs.map((entry) => entry.request_id)).size === profileLogs.length);
  assert.ok(forwardedIds.every((id) => /^[0-9a-f-]{36}$/i.test(id)), 'Caddy must overwrite the client request ID');
  assert.deepEqual(identityLogs.map((entry) => String(entry.aid)), ['123', '123', '123', '456', 'none']);
  assert.equal(identityLogs[2].mode, 'pve');
  assert.equal(identityLogs[4].aid_state, 'unparsed');
  for (const entry of profileLogs) {
    assert.ok(Number.isFinite(entry.ts));
    assert.equal(entry.request.uri, undefined);
    assert.equal(entry.request.headers, undefined);
    assert.equal(entry.resp_headers, undefined);
    assert.equal(JSON.stringify(entry).includes('private-'), false);
  }
  assert.ok(profileLogs.slice(0, emptyPaths.length * 2).every((entry) => entry.status === 400 && String(entry.aid) === 'none'));
  t.diagnostic('empty IDs rejected before Next; every profile request logged with safe identity fields');
  const beforePost = received;
  assert.equal((await request('/api/player/profile', 'tarkovstats.ru', 'POST')).status, 200);
  assert.equal(received, beforePost + 1, 'unsupported-method handling must remain with Next, preserving 405/OPTIONS');
  const beforeScans = received;
  const privatePaths = ['/.env', '/.env.production', '/config/.env.local', '/.git/HEAD',
    '/%2egit/config', '/.GIT/config', '/.aws/credentials', '/.ssh/id_rsa',
    '/.terraform/terraform.tfstate', '/terraform.tfstate.backup', '/wp-config.php',
    '/docker-compose.yml', '/docker-compose.prod.yaml'];
  for (const host of ['tarkovstats.ru', 'tarkovstats.online']) {
    for (const path of privatePaths) {
      assert.equal((await request(path, host)).status, 404, `${host}${path}`);
    }
  }
  assert.equal(received, beforeScans, 'scans must never consume backend capacity');
  for (const path of ['/healthz', '/api/player/search?nickname=test', '/player/regular/1',
    '/compare', '/.well-known/security.txt', '/.well-known/acme-challenge/fixture',
    '/_next/static/chunk.js', '/config.json', '/environment', '/.github-logo.svg']) {
    assert.equal((await request(path)).status, 200, `public route ${path}`);
  }
  t.diagnostic('26 private-file scans bypassed the backend; public paths still pass');
  assert.equal((await request('/reset')).status, 502, 'a reset upstream connection must fail only that request');
  const afterReset = await Promise.all([
    request('/leaderboard'),
    request('/_next/static/fixture.js', 'tarkovstats.online'),
  ]);
  assert.ok(afterReset.every((r) => r.status === 200), 'one upstream reset must not block either site or static assets');
  t.diagnostic('both sites respond immediately after one upstream connection reset');
  const pending = [];
  for (let i = 0; i < 32; i++) {
    pending.push(request('/hold', i % 2 ? 'tarkovstats.online' : 'tarkovstats.ru'));
    const accepted = Date.now() + 2000;
    while (held.size < i + 1 && Date.now() < accepted) await delay(10);
    assert.equal(held.size, i + 1);
  }
  const before = received;
  t.diagnostic('32 pending requests accepted across both sites');
  const rejected = await Promise.all(Array.from({ length: 64 }, (_, i) =>
    request('/', i % 2 ? 'tarkovstats.online' : 'tarkovstats.ru')));
  assert.ok(rejected.every((r) => r.status === 503), 'overflow must fail promptly');
  assert.equal(received, before, 'overflow must never reach the backend');
  assert.equal(peak, 32, 'both domains must share the upstream budget');
  t.diagnostic('64 excess requests rejected without reaching the backend');
  for (const res of held) res.end('released');
  assert.ok((await Promise.all(pending)).every((r) => r.status === 200));
  assert.equal((await request()).status, 200, 'capacity returns without a restart');
  t.diagnostic('capacity recovered after releasing the pending requests');
  const started = Date.now();
  const stalled = await request('/stall');
  assert.equal(stalled.status, 504, 'an upstream withholding headers must time out');
  assert.ok(Date.now() - started >= 19_000 && Date.now() - started < 25_000);
  const afterTimeout = await Promise.all([request(), request('/', 'tarkovstats.online')]);
  assert.ok(afterTimeout.every((r) => r.status === 200), 'a timed-out request must release capacity without blocking either site');
});

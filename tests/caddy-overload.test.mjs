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
    if (req.url === '/hold' || req.url === '/stall') held.add(res);
    else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ip: req.headers['x-real-ip'] }));
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
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12_000); });
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
  function request(path = '/', host = 'tarkovstats.ru') {
    return new Promise((resolve, reject) => {
      const stream = client.request({ ':path': path, ':authority': `${host}:${port}`,
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
  assert.equal((await request()).status, 200, 'a timed-out request must release capacity');
});

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const CHALLENGE = '/__profile-check';
const ACTION = 'profile_check';
const COOKIE = '__Host-profile_pass';
const HOSTS = new Set([
  'tarkovstats.online', 'www.tarkovstats.online',
  'tarkovstats.ru', 'www.tarkovstats.ru',
]);
// Turnstile tokens are bound to a hostname configured in the widget. Keep the
// challenge on the hostname already verified there; .ru still gets the token
// bucket (429) and can join this set once its names are added to the widget.
const CHALLENGE_HOSTS = new Set(['tarkovstats.online', 'www.tarkovstats.online']);
// Per-client token bucket: ordinary browsing stays below it, while a single
// address that opens pages in a tight loop is cut before it reaches Next.
const IP_RATE_PER_SECOND = 3;
const IP_BURST = 20;
const IP_IDLE_MS = 60_000;
// A botnet must not turn the per-client map into an unbounded allocation.
const IP_BUCKET_LIMIT = 50_000;
// Global hold: a burst larger than this switches new page visits to Turnstile.
const GLOBAL_WINDOW_MS = 10_000;
const GLOBAL_LIMIT = 50;
const HOLD_MS = 60_000;
const SESSION_SECONDS = 2 * 60 * 60;

function profilePath(input) {
  if (typeof input !== 'string' || input.length > 2048 ||
      !/^\/player(?:\/|\?|$)/i.test(input) || /[\x00-\x20\x7f\\]/.test(input)) return null;
  const url = new URL(input, 'https://tarkovstats.online');
  if (!/^\/player(?:\/|$)/i.test(url.pathname)) return null;
  if (url.searchParams.has('_rsc')) url.searchParams.delete('_rsc');
  return url.pathname + url.search;
}

// Profile pages may be challenged; API calls are only rate limited because an
// XHR cannot complete a Turnstile form.
function admissionTarget(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\x7f\\]/.test(input)) return null;
  const url = new URL(input, 'https://tarkovstats.online');
  if (url.pathname === '/api/player/profile') return { kind: 'api', value: url.pathname };
  const value = profilePath(input);
  return value ? { kind: 'page', value } : null;
}

function html(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function challengePage(req, res, siteKey, target, status = 200) {
  const nonce = randomBytes(18).toString('base64');
  const ru = /^ru(?:\b|[-_])/i.test(req.headers['accept-language'] ?? '');
  const title = ru ? 'Проверка браузера' : 'Browser verification';
  const message = status === 200
    ? (ru ? 'Подождите, пока мы проверим браузер и откроем профиль.' : 'Please wait while we check your browser and open the profile.')
    : (ru ? 'Проверка не завершилась. Попробуйте ещё раз.' : 'Verification did not finish. Please try again.');
  const noScript = ru ? 'Для проверки нужен JavaScript.' : 'This check requires JavaScript.';
  const retry = ru ? 'Повторить проверку' : 'Retry verification';
  const home = ru ? 'На главную' : 'Back to home';
  const unavailable = ru ? 'Не удалось загрузить проверку. Попробуйте ещё раз.' : 'The check could not load. Please try again.';
  const turnstile = 'https://challenges.cloudflare.com';
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' ${turnstile}; frame-src ${turnstile}; connect-src ${turnstile}; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'strict-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`<!doctype html><html lang="${ru ? 'ru' : 'en'}">
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  :root { color-scheme:dark; font: 1rem/1.5 system-ui, sans-serif; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#111; color:#f5f5f5; }
  main { box-sizing:border-box; width:min(100%,32rem); padding:1.25rem; }
  h1 { margin:0 0 .5rem; font-size:1.5rem; }
  a { color:#cdd8ff; } a:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
  nav { display:flex; flex-wrap:wrap; gap:1rem; margin-top:1rem; }
</style>
<main><h1>${title}</h1><p id="status" role="status">${message}</p>
<form method="post" action="${CHALLENGE}">
  <input type="hidden" name="return" value="${html(target)}">
  <input type="hidden" name="token">
  <div class="cf-turnstile" data-sitekey="${html(siteKey)}" data-action="${ACTION}"
    data-appearance="interaction-only" data-size="flexible" data-response-field="false"
    data-callback="profileVerified" data-error-callback="profileVerificationError"></div>
</form>
<noscript><p>${noScript}</p></noscript>
<nav><a href="${CHALLENGE}?return=${encodeURIComponent(target)}">${retry}</a><a href="/">${home}</a></nav>
</main>
<script nonce="${nonce}">
  window.profileVerified = function (token) {
    const form = document.querySelector('form');
    form.elements.token.value = token;
    form.requestSubmit();
  };
  window.profileVerificationError = function () {
    document.getElementById('status').textContent = ${JSON.stringify(unavailable)};
  };
  const script = document.createElement('script');
  script.src = '${turnstile}/turnstile/v0/api.js';
  script.addEventListener('error', window.profileVerificationError);
  document.head.append(script);
</script></html>`);
}

export function createProfileChallenge({
  siteKey,
  signingKey,
  verify,
  clock = () => performance.now(),
  ipRatePerSecond = IP_RATE_PER_SECOND,
  ipBurst = IP_BURST,
  globalWindowMs = GLOBAL_WINDOW_MS,
  globalLimit = GLOBAL_LIMIT,
  holdMs = HOLD_MS,
}) {
  let recent = [];
  let activeUntil = 0;
  let inFlight = 0;
  const buckets = new Map();
  let admissions = 0;

  function sign(host, ip, expiry) {
    return createHmac('sha256', signingKey).update(`${host}:${ip}:${expiry}`).digest('base64url');
  }

  function hasPass(req, host, ip) {
    const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((value) => value.startsWith(COOKIE + '='));
    const token = cookie?.slice(COOKIE.length + 1).match(/^(\d{10})\.([\w-]{43})$/);
    if (!token || Number(token[1]) <= Math.floor(Date.now() / 1000)) return false;
    return timingSafeEqual(Buffer.from(token[2]), Buffer.from(sign(host, ip, token[1])));
  }

  function hasTokens(ip, now) {
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size >= IP_BUCKET_LIMIT) buckets.delete(buckets.keys().next().value);
      bucket = { tokens: ipBurst, at: now };
      buckets.set(ip, bucket);
    } else {
      bucket.tokens = Math.min(ipBurst, bucket.tokens + ((now - bucket.at) / 1000) * ipRatePerSecond);
      bucket.at = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    if (++admissions % 1024 === 0) {
      for (const [key, value] of buckets) if (now - value.at >= IP_IDLE_MS) buckets.delete(key);
    }
    return true;
  }

  function registerPage(now) {
    recent = recent.filter((at) => at > now - globalWindowMs);
    recent.push(now);
    if (recent.length >= globalLimit) {
      activeUntil = now + holdMs;
      recent = [];
    }
  }

  return createServer({ requestTimeout: 8000, headersTimeout: 4000, maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const host = req.headers.host;
    const ip = req.headers['x-profile-client-ip'];
    if (!HOSTS.has(host) || typeof ip !== 'string' || !isIP(ip)) return res.writeHead(404).end();
    if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
      return res.writeHead(400).end();
    }
    const url = new URL(req.url, 'https://' + host);
    if (url.pathname === '/internal/profile-admission' && req.method === 'GET') {
      const target = admissionTarget(req.headers['x-forwarded-uri']);
      if (!target) return res.writeHead(400).end();
      const now = clock();
      if (!hasTokens(ip, now)) return res.writeHead(429, { 'Retry-After': '10' }).end();
      if (target.kind === 'api' || !CHALLENGE_HOSTS.has(host)) return res.writeHead(204).end();
      registerPage(now);
      if (hasPass(req, host, ip)) return res.writeHead(204).end();
      if (now < activeUntil) {
        if (req.headers.rsc === '1' && req.headers['next-router-prefetch'] === '1') {
          return res.writeHead(429, { 'Retry-After': '10' }).end();
        }
        return res.writeHead(302, { Location: CHALLENGE + '?return=' + encodeURIComponent(target.value) }).end();
      }
      return res.writeHead(204).end();
    }

    if (url.pathname !== CHALLENGE) return res.writeHead(404).end();
    if (req.method === 'GET') {
      const target = profilePath(url.searchParams.get('return'));
      if (!target) return res.writeHead(400).end();
      if (hasPass(req, host, ip)) return res.writeHead(303, { Location: target }).end();
      return challengePage(req, res, siteKey, target);
    }
    if (req.method !== 'POST') return res.writeHead(405, { Allow: 'GET, POST' }).end();
    if (req.headers.origin !== 'https://' + host ||
        !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return res.writeHead(403).end();
    }
    let body = '';
    req.setEncoding('utf8');
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) return res.writeHead(413).end();
      }
    } catch {
      return res.destroy();
    }
    const form = new URLSearchParams(body);
    const target = profilePath(form.get('return'));
    const token = form.get('token');
    if (!target || !token || token.length > 2048) return res.writeHead(400).end();
    if (hasPass(req, host, ip)) return res.writeHead(303, { Location: target }).end();
    if (inFlight >= 4) return challengePage(req, res, siteKey, target, 429);
    inFlight++;
    try {
      const result = await verify(token);
      if (result.success !== true || result.hostname !== host || result.action !== ACTION) {
        return challengePage(req, res, siteKey, target, 403);
      }
      const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      return res.writeHead(303, {
        Location: target,
        'Set-Cookie': `${COOKIE}=${expiry}.${sign(host, ip, expiry)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      }).end();
    } catch {
      return challengePage(req, res, siteKey, target, 503);
    } finally {
      inFlight--;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, PROFILE_CHALLENGE_SIGNING_KEY } = process.env;
  if (!/^[\w-]{16,100}$/.test(TURNSTILE_SITE_KEY ?? '') || !/^[\w-]{16,120}$/.test(TURNSTILE_SECRET_KEY ?? '') ||
      /^\dx0{10}/.test(TURNSTILE_SITE_KEY) || /^\dx0{10}/.test(TURNSTILE_SECRET_KEY) ||
      !/^[a-f0-9]{64}$/i.test(PROFILE_CHALLENGE_SIGNING_KEY ?? '')) {
    throw new Error('Configure production Turnstile keys and a 32-byte hexadecimal signing key');
  }
  const server = createProfileChallenge({
    siteKey: TURNSTILE_SITE_KEY,
    signingKey: Buffer.from(PROFILE_CHALLENGE_SIGNING_KEY, 'hex'),
    verify: async (response) => {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response }),
        redirect: 'error',
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) throw new Error('Siteverify unavailable');
      return res.json();
    },
  });
  server.listen(3119, '0.0.0.0');
}

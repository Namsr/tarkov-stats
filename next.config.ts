import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// CSP без nonce — чтобы не ломать статический кэш страниц (nonce заставил бы
// рендерить всё динамически). 'unsafe-inline' нужен для inline-бутстрапа Next и
// inline-стилей; внешние источники минимальны:
//   challenges.cloudflare.com — Turnstile (скрипт + iframe + XHR)
//   lh3.googleusercontent.com — аватар залогиненного через Google пользователя
// Браузер ходит на upstream (tarkov.dev) только через наши /api/* роуты, поэтому
// в connect-src его НЕТ — нужен лишь 'self'. В dev добавляем 'unsafe-eval'
// (React refresh) и ws: (HMR).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://lh3.googleusercontent.com",
  "font-src 'self'",
  `connect-src 'self' https://challenges.cloudflare.com${isDev ? " ws:" : ""}`,
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  // HSTS — только в проде (на http://localhost браузер его всё равно игнорит, но
  // не светим заголовок в dev). 1 год + поддомены (www); без preload, чтобы не
  // брать необратимое обязательство. Прод всегда за HTTPS (Cloudflare/Caddy).
  ...(isDev
    ? []
    : [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]),
];

const nextConfig: NextConfig = {
  // Минимальный self-contained вывод для Docker-образа:
  // .next/standalone содержит только нужные для рантайма файлы.
  output: "standalone",
  // Убираем x-powered-by: Next.js — не светим стек.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

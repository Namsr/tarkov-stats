import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const home = new Set([
  "lib/home-counter.ts", "lib/home-counter-sampler.ts", "lib/public-home-counter.ts",
  "lib/public-index-coverage.ts", "lib/public-ban-counter.ts", "scripts/sample-home-coverage.mjs",
  "components/home/HomeScanRail.tsx", "app/api/home/coverage/route.ts",
  "tests/public-index-coverage.test.ts", "tests/home-showcase-mode.test.mjs",
]);
const runtime = new Set([
  "Dockerfile", ".dockerignore", "ops/docker-compose.vps.yml", "scripts/start-web.mjs",
  "scripts/supervise-worker.mjs", "tests/worker-supervisor.test.mjs", "tests/runtime-health.test.mjs",
]);
const ci = new Set([
  ".github/workflows/vps-image.yml", "scripts/ci-scope.mjs", "tests/background-isolation.test.mjs",
]);
const navigation = new Set([
  "components/AverageNavButton.tsx", "components/AxisLeaguePage.tsx", "components/FaqWidget.tsx",
  "components/LeaderboardPage.tsx", "components/SiteFooter.tsx", "components/SiteHeader.tsx",
]);
const proxy = new Set([
  "ops/Caddyfile", "tests/caddy-overload.test.mjs", "tests/rust-http-proxy.test.mjs",
  "scripts/serve-rust-arena-benchmark.mjs", "tests/rust-arena-browser-lifecycle.test.mjs",
]);

/** Unknown/shared changes fail closed to the full gate. Groups compose, so a
 * mixed PR runs the union of its checks rather than qualifying as one exception. */
export function selectCiScope(paths, eventName) {
  const scope = { full: false, home_counter: false, ops: false, proxy: false,
    navigation: false, arena_browser: false, benchmarks: false, runtime_contract: false,
    image: eventName !== "pull_request" };
  if (!["pull_request", "push"].includes(eventName) || !paths?.length) scope.full = true;
  for (const path of paths ?? []) {
    if (/^(docs\/.*|README\.md|PERFORMANCE\.md)$/.test(path)) continue;
    scope.image = true;
    if (home.has(path)) scope.home_counter = true;
    else if (runtime.has(path) || ci.has(path)) {
      scope.ops = true;
      scope.runtime_contract = true;
    } else if (navigation.has(path)) {
      scope.navigation = true;
      scope.proxy = true;
    } else if (proxy.has(path)) {
      scope.proxy = true;
      if (["ops/Caddyfile", "scripts/serve-rust-arena-benchmark.mjs", "tests/rust-arena-browser-lifecycle.test.mjs"].includes(path)) {
        scope.arena_browser = true;
      }
    } else scope.full = true;
  }
  if (scope.full) {
    for (const key of ["image", "benchmarks", "runtime_contract", "arena_browser"]) scope[key] = true;
  }
  return scope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const paths = process.argv[2] ? readFileSync(process.argv[2], "utf8").split("\0").filter(Boolean) : null;
  const scope = selectCiScope(paths, process.env.GITHUB_EVENT_NAME);
  const output = Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

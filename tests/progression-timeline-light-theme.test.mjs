import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function linearize(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function extractBlock(source, selector) {
  const index = source.indexOf(selector);
  assert.ok(index >= 0, `missing block ${selector}`);
  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  assert.ok(open >= 0 && close > open, `malformed block ${selector}`);
  return source.slice(open + 1, close);
}

function extractVars(block) {
  const vars = new Map();
  for (const match of block.matchAll(/(--timeline-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    vars.set(match[1], match[2].toLowerCase());
  }
  return vars;
}

test("progression timeline defines a separate light-theme palette", async () => {
  const styles = await readFile("app/globals.css", "utf8");

  assert.match(styles, /html\[data-theme="light"\]\s*\.progression-timeline\s*\{/);

  const darkBlock = extractBlock(styles, ".progression-timeline {");
  const lightSelector = 'html[data-theme="light"] .progression-timeline {';
  const lightIndex = styles.indexOf(lightSelector);
  assert.ok(lightIndex >= 0, "missing light-theme timeline palette");
  const lightBlock = extractBlock(styles.slice(lightIndex), ".progression-timeline {");

  const darkVars = extractVars(darkBlock);
  const lightVars = extractVars(styles.slice(lightIndex, lightIndex + lightBlock.length + lightSelector.length));

  const required = [
    "--timeline-xp",
    "--timeline-xp-day",
    "--timeline-raids-day",
    "--timeline-pmc-kills-day",
    "--timeline-non-pmc-kills-day",
    "--timeline-pmc-kills-raid",
    "--timeline-non-pmc-kills-raid",
    "--timeline-survival",
    "--timeline-pvp-kd",
    "--timeline-ai-kd",
    "--timeline-xp-line",
    "--timeline-raids-line",
    "--timeline-pvp-kd-line",
    "--timeline-ai-kd-line",
    "--timeline-survival-line",
  ];
  for (const name of required) {
    assert.ok(lightVars.has(name), `light palette must define ${name}`);
  }

  // Light card background is #ffffff (see html[data-theme="light"]).
  assert.match(styles, /html\[data-theme="light"\][\s\S]*?--card-bg:\s*#ffffff/);
});

test("light-theme active timeline colors keep at least 3:1 contrast on white", async () => {
  const styles = await readFile("app/globals.css", "utf8");
  const lightSelector = 'html[data-theme="light"] .progression-timeline {';
  const lightIndex = styles.indexOf(lightSelector);
  const lightBlock = extractBlock(styles.slice(lightIndex), ".progression-timeline {");
  const lightVars = extractVars(styles.slice(lightIndex, lightIndex + lightBlock.length + lightSelector.length));

  const white = "#ffffff";
  const failures = [];
  for (const [name, color] of lightVars) {
    const ratio = contrast(color, white);
    if (ratio < 3) failures.push(`${name} ${color} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, [], `light timeline colors below 3:1 on white: ${failures.join(", ")}`);

  // Regression anchors from issue #16: these dark-theme values failed on white
  // (XP 2.02, raids 2.40, survival 1.90, PVP K/D 1.67, XP_COLOR 1.73).
  const anchors = {
    "--timeline-xp": "#b45309",
    "--timeline-raids-line": "#0f766e",
    "--timeline-survival-line": "#15803d",
    "--timeline-pvp-kd": "#a16207",
    "--timeline-xp-line": "#b45309",
  };
  for (const [name, expected] of Object.entries(anchors)) {
    assert.equal(lightVars.get(name), expected);
    assert.ok(contrast(expected, white) >= 3, `${name} ${expected} must be >= 3:1`);
  }
});

test("progression timeline component resolves line colors through light-theme variables", async () => {
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");

  assert.match(chart, /var\(--timeline-xp-line,\s*#ffb74d\)/);
  assert.match(chart, /var\(--timeline-raids-line,\s*#81b29a\)/);
  assert.match(chart, /var\(--timeline-pvp-kd-line,\s*#f778ba\)/);
  assert.match(chart, /var\(--timeline-ai-kd-line,\s*#58a6ff\)/);
  assert.match(chart, /var\(--timeline-survival-line,\s*#3fb950\)/);
  // No hardcoded low-contrast line color may remain as the resolved value.
  assert.doesNotMatch(chart, /const XP_COLOR = "#ffb74d"/);
  assert.doesNotMatch(chart, /const RAIDS_COLOR = "#81b29a"/);
  assert.doesNotMatch(chart, /\{\s*key:\s*"pvp_kd"[^}]*color:\s*"#f778ba"/);
  // SVG gradient and axis paint must go through style so var() resolves.
  assert.match(chart, /<stop[^>]*style=\{\{\s*stopColor:\s*leftColor\s*\}\}/);
  assert.match(chart, /style=\{\{\s*stroke:\s*metric\.color\s*\}\}/);
  assert.match(chart, /style=\{\{\s*fill:\s*metric\.color\s*\}\}/);
});

test("light theme keeps selected, nearby, overall, highlight and dim states readable", async () => {
  const styles = await readFile("app/globals.css", "utf8");
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");

  // All series/state selectors still exist.
  for (const selector of [
    "progression-timeline__line--player",
    "progression-timeline__line--nearby",
    "progression-timeline__line--overall",
    "progression-timeline__line--selected",
    "progression-timeline__line--dim",
    "progression-timeline__line--segment-context",
    "progression-timeline__line--highlight",
    "progression-timeline__point--overall",
    "progression-timeline__point--nearby",
    "progression-timeline__point--dim",
    "progression-timeline__point--highlight",
  ]) {
    assert.ok(styles.includes(selector), `missing state ${selector}`);
  }

  // Dark-theme dim/context baselines from the issue.
  assert.match(styles, /\.progression-timeline__line--dim[^}]*opacity:\s*\.18/);
  assert.match(styles, /\.progression-timeline__line--segment-context[^}]*opacity:\s*\.32/);

  // Light-theme overrides raise dim/context above the dark baselines
  // while staying visibly de-emphasized (below full opacity).
  const dimLight = styles.match(/html\[data-theme="light"\]\s*\.progression-timeline__line--dim[^}]*opacity:\s*([.\d]+)/);
  const contextLight = styles.match(/html\[data-theme="light"\]\s*\.progression-timeline__line--segment-context[^}]*opacity:\s*([.\d]+)/);
  assert.ok(dimLight, "light theme must override --dim line opacity");
  assert.ok(contextLight, "light theme must override --segment-context line opacity");
  assert.ok(Number(dimLight[1]) > 0.32, `light dim ${dimLight[1]} must exceed dark 0.18/0.32`);
  assert.ok(Number(contextLight[1]) > 0.5, `light segment-context ${contextLight[1]} must exceed dark 0.32`);
  assert.ok(Number(dimLight[1]) < 1 && Number(contextLight[1]) <= 1, "dim states must stay below full opacity");

  // Overall/nearby stay distinguishable in light theme via raised paint opacity.
  assert.match(styles, /html\[data-theme="light"\]\s*\.progression-timeline__line--overall[^}]*stroke-opacity:\s*\.8/);
  assert.match(styles, /html\[data-theme="light"\]\s*\.progression-timeline__line--nearby[^}]*stroke-opacity:\s*\.9/);
  assert.match(styles, /html\[data-theme="light"\]\s*\.progression-timeline__point--overall[^}]*opacity:\s*\.8/);

  // Component still renders every series state.
  assert.match(chart, /progression-timeline__line--\$\{seriesKey\}/);
  assert.match(chart, /progression-timeline__line--\$\{layer\}/);
  assert.match(chart, /progression-timeline__line--dim/);
  assert.match(chart, /progression-timeline__line--segment-context/);
  assert.match(chart, /progression-timeline__line--highlight/);
  assert.match(chart, /SELECTED_SERIES_STYLE/);
  assert.match(chart, /SERIES_STYLES\[seriesKey\]/);
});

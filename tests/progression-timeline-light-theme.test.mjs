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

function block(source, selector) {
  const index = source.indexOf(selector);
  assert.ok(index >= 0, `missing block ${selector}`);
  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  assert.ok(open >= 0 && close > open, `malformed block ${selector}`);
  return source.slice(open + 1, close);
}

function vars(source) {
  const found = new Map();
  for (const match of source.matchAll(/(--profile-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    found.set(match[1], match[2].toLowerCase());
  }
  return found;
}

const CHART_COLORS = ["--profile-positive", "--profile-other", "--profile-report"];

test("the profile chart redefines its palette for the light theme", async () => {
  const css = await readFile("components/profile.css", "utf8");
  const dark = vars(block(css, ".profile-page {"));
  const light = vars(block(css, 'html[data-theme="light"] .profile-page'));

  // Every colour the timeline paints with must have a light-theme override, or
  // the dark value ships on white and the chart drops below readable contrast.
  for (const name of CHART_COLORS) {
    assert.ok(dark.has(name), `dark palette must define ${name}`);
    assert.ok(light.has(name), `light palette must define ${name}`);
    assert.notEqual(light.get(name), dark.get(name), `${name} must actually change in light theme`);
  }

  const white = "#ffffff";
  for (const name of CHART_COLORS) {
    const value = light.get(name);
    assert.ok(contrast(value, white) >= 3, `${name} ${value} must be >= 3:1 on white, got ${contrast(value, white).toFixed(2)}`);
  }
});

test("the timeline paints through theme variables, never a hardcoded series colour", async () => {
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");
  const css = await readFile("components/profile.css", "utf8");

  // Stroke paint is declared once in the stylesheet and routed through the
  // palette variables, so switching theme re-colours the chart.
  assert.match(css, /\.profile-chart-line \{[^}]*stroke: var\(--foreground\)/);
  assert.match(css, /\.profile-chart-line\.is-overall \{[^}]*stroke: var\(--profile-positive\)/);
  assert.match(css, /\.profile-chart-line\.is-old \{[^}]*stroke: var\(--profile-other\)/);
  assert.match(css, /\.profile-chart-line\.is-selected \{[^}]*stroke: var\(--profile-other\)/);
  assert.match(css, /\.profile-chart-legend i\.is-overall \{[^}]*border-top: 2px dashed var\(--profile-positive\)/);

  // The per-metric palette this chart used to carry is gone, along with the
  // low-contrast dark-theme defaults it fell back to. None may come back.
  for (const removed of ["#ffb74d", "#81b29a", "#f778ba", "#58a6ff", "#3fb950"]) {
    assert.doesNotMatch(chart, new RegExp(removed, "i"), `${removed} must not return as a series colour`);
  }
  for (const removed of ["XP_COLOR", "RAIDS_COLOR", "SERIES_STYLES", "SELECTED_SERIES_STYLE", "leftColor"]) {
    assert.doesNotMatch(chart, new RegExp(removed), `${removed} must not return`);
  }
  // The component resolves its own accent colours through the palette, not hex.
  for (const name of CHART_COLORS) {
    assert.ok(chart.includes(`var(${name})`) || css.includes(`var(${name})`), `${name} must be consumed somewhere`);
  }
  assert.doesNotMatch(chart, /fill="#[0-9a-fA-F]{3,6}"/);
  assert.doesNotMatch(chart, /stroke="#[0-9a-fA-F]{3,6}"/);
  // The superseded --timeline-* custom properties are not part of this design.
  assert.doesNotMatch(chart, /var\(--timeline-/);
});

test("player, average, previous-character and comparison lines stay distinguishable", async () => {
  const css = await readFile("components/profile.css", "utf8");
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");

  const rules = new Map();
  for (const match of css.matchAll(/(\.profile-chart-line(?:\.[a-z-]+)?)\s*\{([^}]*)\}/g)) {
    rules.set(match[1], match[2]);
  }

  // A previous character and the compared profile share --profile-other, so
  // they must be told apart by dash pattern or they render identically.
  const old = rules.get(".profile-chart-line.is-old");
  const selected = rules.get(".profile-chart-line.is-selected");
  assert.ok(old && selected, "both de-emphasised states need a rule");
  assert.match(old, /stroke-dasharray: \d/);
  assert.match(selected, /stroke-dasharray: \d/);
  assert.notEqual(
    old.match(/stroke-dasharray: ([^;]+)/)[1].trim(),
    selected.match(/stroke-dasharray: ([^;]+)/)[1].trim(),
    "previous-character and comparison lines must not share a dash pattern",
  );
  // The average is the one positive series and must stay visually distinct.
  assert.match(rules.get(".profile-chart-line.is-overall"), /stroke-dasharray: \d/);

  // The component still emits all four series states.
  for (const state of ["is-overall", "is-selected", "is-old"]) {
    assert.ok(chart.includes(state), `component must still render ${state}`);
  }
  assert.match(chart, /className="profile-chart-line is-overall"/);
  assert.match(chart, /className=\{`profile-chart-line /);
  assert.match(chart, /data-series=\{segment\[0\]\?\.seriesId \?\? "player"\}/);
  // Keyboard and pointer affordances the chart depends on.
  assert.match(chart, /className="profile-chart-hit"/);
  assert.match(chart, /role="button" tabIndex=\{0\}/);
  assert.match(chart, /if \(event\.key === "Escape"\) clear\(\)/);
});

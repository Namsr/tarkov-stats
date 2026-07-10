# TarkovStats Tactical UI

## Intent

TarkovStats is a player-intelligence tool, not a game landing page. The visual language is inspired by SpaceX's engineered restraint: warm-white canvas, sharp black hierarchy, condensed display type and hairline structure. It must remain unmistakably independent of SpaceX and Escape from Tarkov marketing materials.

## Hard constraints

- Never use photos, videos, generated imagery, third-party artwork, or copied brand marks.
- Use CSS-only atmosphere: restrained grids, contour lines, radial light and geometric framing.
- Keep all user-facing copy in the EN/RU i18n dictionary.
- Preserve readable contrast, visible keyboard focus, 44px minimum touch controls, and no horizontal scrolling at 360px.

## Visual system

- Canvas: warm white. Surfaces differ by only one restrained elevation step and use 1px hairlines instead of shadows.
- Typography: compact industrial stack for headings; neutral system sans for body UI; tabular numerals for statistics.
- Color: black carries structure and primary actions. There is no decorative brand accent; green/red only communicate positive/negative analytical signals.
- Motion: 150–220ms opacity, transform and border-color transitions only. No autoplay, parallax, glow loops or decorative motion.

## Layout rules

- Desktop content is a maximum 1240px field with generous horizontal breathing room.
- The home page is a single mission panel. Profile and average pages start with a concise operational summary, then expose detail in grouped data surfaces.
- Navigation becomes a compact disclosure below 768px. Controls may wrap or stack, never overflow.
- Avoid anonymous grids of identical cards: distinguish primary signals, raw data and drill-down panels through placement and density.

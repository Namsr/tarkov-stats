<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# The UI is bilingual (EN/RU) — never hardcode user-facing text

All user-visible strings (text, placeholders, button labels, titles/aria-labels, alt) go through the i18n layer. When adding or changing a feature:

1. In the component, get `const { t } = useI18n()` (from `@/lib/i18n/context`) and render text via `t("ns.key")`, or `t("ns.key", { n })` for `{n}`-style placeholders. The component must be a client component (`"use client"`).
2. Add the key to **both** `en` and `ru` in `lib/i18n/dictionary.ts`. Write real Russian — natural, not a literal calque (terms: PMC→ЧВК, Scav→Дикий, playtime→наигрыш).
3. Shared/cross-file labels already exist — reuse them: `metric.*` (stat names), `common.*`, `nav.*`, `range.all`, `unit.h`. Don't duplicate.

`t()` falls back `ru → en → key`, so a missing translation degrades to English, never crashes. `npm run i18n:check` (also runs on `prebuild`) fails the build if a used `t()` key is undefined or the en/ru key sets diverge — so a one-language feature can't reach prod.
